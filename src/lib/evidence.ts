/**
 * Phase 3 — evidence spans, per-field confidence and derived experience (N1).
 *
 * N1 (non-negotiable): every extracted item must be traceable to a real span of
 * the source document. This module therefore never fabricates a field value
 * without a `char_start`/`char_end` pair, and `verifySpan` re-reads the source to
 * prove the span still resolves. A field whose span cannot be proven is stored
 * with `verified = 0` and `needs_review = 1` — it is never silently trusted.
 *
 * Original-file preservation: nothing here mutates `resumes.raw_text`. Derived
 * values live in `resume_fields`; human edits are appended to
 * `resume_field_corrections`, leaving the original untouched.
 */
import { nowIso } from './util'
import { audit } from './audit'
import { matchTerms, type TaxGraph } from './taxonomy'

export type ExtractedField = {
  field: string
  value: string
  confidence: number
  evidence_text: string
  char_start: number
  char_end: number
  page_no: number | null
}

export type SpanCheck = { ok: boolean; note: string }

/**
 * Prove a span resolves to the text it claims. This is the single gate that
 * every stored evidence row must pass before it may be marked verified.
 */
export const verifySpan = (
  source: string,
  charStart: number | null | undefined,
  charEnd: number | null | undefined,
  claim: string | null | undefined
): SpanCheck => {
  if (charStart === null || charStart === undefined || charEnd === null || charEnd === undefined) {
    return { ok: false, note: 'missing span offsets' }
  }
  if (charStart < 0 || charEnd <= charStart || charEnd > source.length) {
    return { ok: false, note: `span out of bounds (${charStart}-${charEnd} of ${source.length})` }
  }
  const slice = source.slice(charStart, charEnd)
  if (!claim || !claim.trim()) return { ok: false, note: 'empty claim' }
  const a = slice.replace(/\s+/g, ' ').trim().toLowerCase()
  const b = String(claim).replace(/\s+/g, ' ').trim().toLowerCase()
  if (!a) return { ok: false, note: 'span resolves to empty text' }
  if (!a.includes(b) && !b.includes(a)) {
    return { ok: false, note: 'span text does not contain the claim' }
  }
  return { ok: true, note: 'span verified against source' }
}

/* ------------------------------------------------------------- extraction */

const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Find the first literal occurrence and return its offsets in the ORIGINAL text. */
const locate = (source: string, needle: string, from = 0): { start: number; end: number } | null => {
  if (!needle) return null
  const idx = source.toLowerCase().indexOf(needle.toLowerCase(), from)
  if (idx === -1) return null
  return { start: idx, end: idx + needle.length }
}

const SECTION_HEADINGS = [
  'summary', 'profile', 'objective', 'experience', 'work experience', 'employment',
  'professional experience', 'education', 'skills', 'technical skills', 'core competencies',
  'certifications', 'projects', 'achievements', 'publications', 'languages'
]

export const splitSections = (source: string) => {
  const lines = source.split('\n')
  const out: { heading: string; startLine: number; body: string }[] = []
  let current: { heading: string; startLine: number; lines: string[] } | null = null
  lines.forEach((line, i) => {
    const probe = clean(line).toLowerCase().replace(/[:•\-–]+$/g, '').trim()
    if (SECTION_HEADINGS.includes(probe) || (probe.length <= 30 && SECTION_HEADINGS.some((h) => probe === h))) {
      if (current) out.push({ heading: current.heading, startLine: current.startLine, body: current.lines.join('\n') })
      current = { heading: probe, startLine: i, lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  })
  if (current) out.push({ heading: current.heading, startLine: current.startLine, body: current.lines.join('\n') })
  return out
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]{2,}/
const PHONE_RE = /(\+?\d[\d\s().-]{8,}\d)/
const LINKEDIN_RE = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w-]{3,}/i
const YEAR_RANGE_RE = /\b((?:19|20)\d{2})\s*(?:-|–|—|to)\s*((?:19|20)\d{2}|present|current|till date|now)\b/gi
const YEARS_EXPLICIT_RE = /\b(\d{1,2})(?:\.\d)?\s*\+?\s*(?:years?|yrs?)\s*(?:of\s*)?(?:relevant\s*|total\s*|professional\s*)?(?:experience|exp)\b/gi

/**
 * Extract every field with a provable span. Values with no locateable span are
 * returned in `unverified` so the caller can surface them for human review
 * instead of quietly trusting them.
 */
export const extractFieldsWithSpans = (
  rawText: string,
  graph?: TaxGraph | null
): { fields: ExtractedField[]; unverified: { field: string; value: string; reason: string }[] } => {
  const source = rawText || ''
  const fields: ExtractedField[] = []
  const unverified: { field: string; value: string; reason: string }[] = []

  const add = (field: string, value: string, surface: string, confidence: number) => {
    const v = clean(value)
    if (!v) return
    const span = locate(source, surface) || locate(source, v)
    if (!span) {
      unverified.push({ field, value: v, reason: 'no locateable span in source text' })
      return
    }
    const evidence = source.slice(span.start, span.end)
    fields.push({
      field, value: v, confidence: Math.round(confidence * 100) / 100,
      evidence_text: evidence, char_start: span.start, char_end: span.end, page_no: null
    })
  }

  // --- contact block (high confidence: exact literal match required)
  const email = source.match(EMAIL_RE)
  if (email) add('email', email[0], email[0], 0.99)

  const phone = source.match(PHONE_RE)
  if (phone) {
    const digits = phone[0].replace(/\D/g, '')
    if (digits.length >= 9 && digits.length <= 15) add('phone', phone[0].trim(), phone[0].trim(), 0.85)
  }

  const li = source.match(LINKEDIN_RE)
  if (li) add('linkedin', li[0], li[0], 0.95)

  // --- name: first non-empty line that is not contact data or a heading
  const headLines = source.split('\n').slice(0, 8).map(clean).filter(Boolean)
  const nameLine = headLines.find(
    (l) =>
      l.length >= 3 && l.length <= 48 &&
      !EMAIL_RE.test(l) && !PHONE_RE.test(l) && !/^https?:/i.test(l) &&
      !SECTION_HEADINGS.includes(l.toLowerCase().replace(/[:•\-–]+$/g, '').trim()) &&
      /^[A-Za-z][A-Za-z.'\-\s]+$/.test(l) &&
      l.split(/\s+/).length <= 5
  )
  if (nameLine) add('full_name', nameLine, nameLine, 0.9)

  // --- explicit total experience
  let explicitYears: number | null = null
  for (const m of source.matchAll(YEARS_EXPLICIT_RE)) {
    const n = Number(m[1])
    if (n > 0 && n < 50) { explicitYears = n; add('experience_years', String(n), m[0], 0.9); break }
  }

  // --- employment timeline (each range keeps its own span and is later merged)
  const ranges: { start: number; end: number; surface: string; startIdx: number; endIdx: number }[] = []
  for (const m of source.matchAll(YEAR_RANGE_RE)) {
    const from = Number(m[1])
    const toRaw = m[2]
    const to = /^\d+$/.test(toRaw) ? Number(toRaw) : new Date().getFullYear()
    if (to >= from && to - from <= 45) {
      ranges.push({
        start: from, end: to, surface: m[0],
        startIdx: (m.index ?? 0), endIdx: (m.index ?? 0) + m[0].length
      })
    }
  }
  if (ranges.length) {
    add('employment_timeline', ranges.map((r) => r.surface).join(' | '), ranges[0].surface, 0.8)
  }

  // --- current employer: text immediately after a role line containing "at"
  const employerRx = /(?:^|\n)\s*([A-Za-z][A-Za-z &.,'-]{2,40}?)\s*(?:[-–|,]\s*|\s+at\s+)([A-Z][A-Za-z0-9&.,'\- ]{2,40})/g
  let em: RegExpExecArray | null
  let employerHits = 0
  while ((em = employerRx.exec(source)) && employerHits < 3) {
    const company = clean(em[2]).replace(/[,.]$/, '')
    if (company.length >= 2 && !/^(the|and|a|an)$/i.test(company)) {
      add('current_employer', company, company, 0.72)
      employerHits++
    }
  }

  // --- education
  const eduRx = /((?:bachelor|master|b\.?\s?tech|m\.?\s?tech|b\.?\s?e\.?|m\.?\s?e\.?|b\.?sc|m\.?sc|mba|ph\.?d|diploma)[^.\n]{0,80})/gi
  let ed: RegExpExecArray | null
  let eduHits = 0
  while ((ed = eduRx.exec(source)) && eduHits < 3) {
    const v = clean(ed[1])
    if (v.length > 5) { add('education', v, v, 0.78); eduHits++ }
  }

  // --- taxonomy-backed skills (each keeps its own surface span)
  if (graph) {
    const sectionBodies = splitSections(source).filter((s) => s.heading.includes('skill') || s.heading.includes('competenc'))
    const skillBlob = sectionBodies.length ? sectionBodies.map((s) => s.body).join('\n') : source
    const inSkillsSection = new Set(matchTerms(graph, skillBlob).map((m) => m.nodeId))
    const all = matchTerms(graph, source)
    for (const m of all) {
      if (m.kind !== 'technical_skill' && m.kind !== 'software_tool' && m.kind !== 'standard_protocol') continue
      // A hit inside an explicit Skills section is stronger than one buried in prose.
      const confidence = inSkillsSection.has(m.nodeId) ? Math.min(0.95, m.strength) : Math.min(0.7, m.strength * 0.8)
      add(`skill:${m.code}`, m.name, m.surface, confidence)
    }
  }

  return { fields, unverified }
}

/* ---------------------------------------------------------- experience calc */

export type ExperienceResult = {
  years: number
  method: 'explicit' | 'timeline' | 'sections' | 'none'
  spans: { surface: string; start: number; end: number; years: number }[]
  confidence: number
  note: string
}

/**
 * Experience is computed, never guessed:
 *  1. an explicit "N years of experience" statement wins;
 *  2. otherwise overlapping year ranges are merged so 2018-2020 + 2019-2021 is
 *     3 years, not 4;
 *  3. otherwise we report 0 with `method: 'none'` and low confidence rather than
 *     inventing a number.
 */
export const computeExperience = (rawText: string): ExperienceResult => {
  const source = rawText || ''
  const explicit = [...source.matchAll(YEARS_EXPLICIT_RE)]
    .map((m) => ({ n: Number(m[1]), surface: m[0], idx: m.index ?? 0 }))
    .filter((x) => x.n > 0 && x.n < 50)
    .sort((a, b) => b.n - a.n)

  if (explicit.length) {
    const best = explicit[0]
    return {
      years: best.n,
      method: 'explicit',
      spans: [{ surface: best.surface, start: best.idx, end: best.idx + best.surface.length, years: best.n }],
      confidence: 0.9,
      note: 'Stated total in the document'
    }
  }

  const ranges: { start: number; end: number; surface: string; startIdx: number; endIdx: number }[] = []
  for (const m of source.matchAll(YEAR_RANGE_RE)) {
    const from = Number(m[1])
    const toRaw = m[2]
    const to = /^\d+$/.test(toRaw) ? Number(toRaw) : new Date().getFullYear()
    if (to >= from && to - from <= 45 && from >= 1960) {
      ranges.push({ start: from, end: to, surface: m[0], startIdx: m.index ?? 0, endIdx: (m.index ?? 0) + m[0].length })
    }
  }

  if (ranges.length) {
    // Merge overlapping intervals — the union, not the sum.
    const sorted = [...ranges].sort((a, b) => a.start - b.start)
    const merged: { start: number; end: number }[] = []
    for (const r of sorted) {
      const last = merged[merged.length - 1]
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
      else merged.push({ start: r.start, end: r.end })
    }
    const years = merged.reduce((acc, m) => acc + (m.end - m.start), 0)
    return {
      years,
      method: 'timeline',
      spans: ranges.map((r) => ({ surface: r.surface, start: r.startIdx, end: r.endIdx, years: r.end - r.start })),
      confidence: ranges.length >= 2 ? 0.8 : 0.6,
      note: `${ranges.length} date range(s) merged into ${merged.length} continuous period(s)`
    }
  }

  return { years: 0, method: 'none', spans: [], confidence: 0, note: 'No experience evidence found in the document' }
}

/* -------------------------------------------------------------- persistence */

export const persistResumeFields = async (
  db: D1Database,
  opts: {
    resumeId: number
    candidateId: number
    tenantId: number
    rawText: string
    graph?: TaxGraph | null
  }
) => {
  const { fields, unverified } = extractFieldsWithSpans(opts.rawText, opts.graph ?? null)
  const exp = computeExperience(opts.rawText)

  let stored = 0
  let verified = 0
  for (const f of fields) {
    const check = verifySpan(opts.rawText, f.char_start, f.char_end, f.evidence_text)
    const isVerified = check.ok ? 1 : 0
    if (check.ok) verified++
    await db
      .prepare(
        `INSERT INTO resume_fields
           (tenant_id, resume_id, candidate_id, field, value, confidence, evidence_text,
            span_start, span_end, char_start, char_end, page_no, verified, needs_review, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(resume_id, field) DO UPDATE SET
           value = excluded.value, confidence = excluded.confidence,
           evidence_text = excluded.evidence_text, char_start = excluded.char_start,
           char_end = excluded.char_end, verified = excluded.verified,
           needs_review = excluded.needs_review`
      )
      .bind(
        opts.tenantId, opts.resumeId, opts.candidateId, f.field, f.value, f.confidence,
        f.evidence_text, f.char_start, f.char_end, f.char_start, f.char_end, f.page_no,
        isVerified, check.ok ? 0 : 1, nowIso()
      )
      .run()
    stored++
  }

  // Experience is stored as its own evidenced field so the UI can show the maths.
  if (exp.method !== 'none') {
    const first = exp.spans[0]
    const check = first ? verifySpan(opts.rawText, first.start, first.end, first.surface) : { ok: false }
    await db
      .prepare(
        `INSERT INTO resume_fields
           (tenant_id, resume_id, candidate_id, field, value, confidence, evidence_text,
            char_start, char_end, verified, needs_review, created_at)
         VALUES (?, ?, ?, 'experience_years', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(resume_id, field) DO UPDATE SET
           value = excluded.value, confidence = excluded.confidence,
           evidence_text = excluded.evidence_text, char_start = excluded.char_start,
           char_end = excluded.char_end, verified = excluded.verified`
      )
      .bind(
        opts.tenantId, opts.resumeId, opts.candidateId, String(exp.years), exp.confidence,
        first?.surface ?? '', first?.start ?? null, first?.end ?? null,
        check.ok ? 1 : 0, check.ok ? 0 : 1, nowIso()
      )
      .run()
    stored++
  }

  return {
    stored,
    verified,
    unverified,
    experience: exp,
    needsReview: unverified.length + (fields.length - verified)
  }
}

export const loadResumeFields = async (db: D1Database, resumeId: number) => {
  const { results } = await db
    .prepare(
      `SELECT * FROM resume_fields WHERE resume_id = ?
        ORDER BY needs_review DESC, confidence ASC, field ASC`
    )
    .bind(resumeId)
    .all<any>()
  return results
}

/** Human correction: appends the change, never rewrites the original document. */
export const correctField = async (
  db: D1Database,
  opts: { resumeId: number; field: string; newValue: string; actorId: number; reason?: string }
) => {
  const existing = await db
    .prepare(`SELECT * FROM resume_fields WHERE resume_id = ? AND field = ?`)
    .bind(opts.resumeId, opts.field)
    .first<any>()

  await db
    .prepare(
      `INSERT INTO resume_field_corrections (resume_id, field, old_value, new_value, corrected_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(opts.resumeId, opts.field, existing?.value ?? null, opts.newValue, opts.actorId, nowIso())
    .run()

  if (existing) {
    await db
      .prepare(
        `UPDATE resume_fields SET value = ?, verified = 1, needs_review = 0, confidence = 0.99
          WHERE id = ?`
      )
      .bind(opts.newValue, existing.id)
      .run()
  } else {
    await db
      .prepare(
        `INSERT INTO resume_fields
           (tenant_id, resume_id, candidate_id, field, value, confidence, verified, needs_review, created_at)
         VALUES (1, ?, (SELECT candidate_id FROM resumes WHERE id = ?), ?, ?, 0.99, 1, 0, ?)`
      )
      .bind(opts.resumeId, opts.resumeId, opts.field, opts.newValue, nowIso())
      .run()
  }

  await audit(db, {
    entityType: 'resume_field', entityId: `${opts.resumeId}:${opts.field}`,
    action: 'resume.field.correct', actorId: opts.actorId,
    previousValue: { value: existing?.value ?? null }, newValue: { value: opts.newValue },
    reason: opts.reason ?? null
  })
  return { field: opts.field, previous: existing?.value ?? null, value: opts.newValue }
}

/* ------------------------------------------------------------------ summary */

export const resumeEvidenceSummary = async (db: D1Database, resumeId: number) => {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN needs_review = 1 THEN 1 ELSE 0 END) AS needs_review,
              AVG(confidence) AS avg_confidence
         FROM resume_fields WHERE resume_id = ?`
    )
    .bind(resumeId)
    .first<any>()
  const total = Number(row?.total || 0)
  const verified = Number(row?.verified || 0)
  return {
    total,
    verified,
    needsReview: Number(row?.needs_review || 0),
    avgConfidence: Math.round((Number(row?.avg_confidence) || 0) * 100) / 100,
    evidenceCoverage: total ? Math.round((verified / total) * 1000) / 10 : 0
  }
}
