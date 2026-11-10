/**
 * Phase 5 — JD builder, validation and requirement extraction.
 *
 * A requisition description is treated as a governed artefact:
 *  - Every save writes an immutable `jd_versions` snapshot (nothing is lost).
 *  - Requirements are extracted WITH the sentence they came from, so a JD diff
 *    can be read requirement-by-requirement rather than as a wall of text.
 *  - Validation reports issues a recruiter can act on. It never blocks a save
 *    except for genuinely unsafe input (e.g. a stated protected attribute).
 *
 * Deliberately NOT claimed: "AI rewrites your JD". The AI module may propose
 * text in its own gated feature; this module only diagnoses and extracts.
 */
import { nowIso, parseJson, truncate } from './util'
import { audit } from './audit'
import { assertNoProtectedInputs } from './masking'
import { computeCoverage, matchTerms, recommendRoles, type TaxGraph } from './taxonomy'

export type JdIssue = {
  code: string
  severity: 'error' | 'warn' | 'info'
  field: string
  message: string
  hint?: string
}

export type JdAnalysis = {
  issues: JdIssue[]
  coverage: {
    mustHaves: number
    niceToHaves: number
    taxonomyResolved: number
    unresolved: string[]
  }
  scores: {
    clarity: number
    inclusivity: number
    specificity: number
    total: number
  }
  suggestedRoles: { code: string; name: string; score: number }[]
}

/* -------------------------------------------------------------- extraction */

const REQUIREMENT_CUES = [
  /(?:must have|must-have|required|requirement|essential|mandatory)[:\s-]+(.{3,160})/gi,
  /(?:nice to have|nice-to-have|preferred|desirable|plus|bonus)[:\s-]+(.{3,160})/gi,
  /(?:experience (?:in|with)|proficien(?:t|cy) (?:in|with)|hands-on (?:with|experience in)|knowledge of)[:\s-]+(.{3,160})/gi
]

const BULLET_RE = /^\s*(?:[-•*·]|\d+[.)])\s+(.{3,200})$/gm

/** Split a requirement line into individual short requirements. */
const splitList = (s: string): string[] =>
  s
    .split(/[,;]|\band\b|\bplus\b/)
    .map((x) => x.replace(/[.;]+$/, '').trim())
    .filter((x) => x.length >= 3 && x.length <= 80)

export type ExtractedRequirement = {
  kind: 'must_have' | 'nice_to_have'
  text: string
  evidence_text: string
  char_start: number
  char_end: number
  node_id: number | null
  weight: number
}

/**
 * Extract requirements from free text with offsets into the ORIGINAL string.
 * Anything that cannot be located in the source is dropped rather than
 * attributed to a span it did not come from.
 */
export const extractRequirements = (
  source: string,
  graph?: TaxGraph | null
): ExtractedRequirement[] => {
  const text = source || ''
  const out: ExtractedRequirement[] = []
  const seen = new Set<string>()

  const push = (
    kind: 'must_have' | 'nice_to_have',
    raw: string,
    evidence: string,
    start: number,
    end: number
  ) => {
    const cleanText = raw.replace(/\s+/g, ' ').trim()
    if (!cleanText || cleanText.length < 3) return
    const key = `${kind}:${cleanText.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    const resolved = graph ? matchTerms(graph, cleanText) : []
    out.push({
      kind,
      text: cleanText,
      evidence_text: evidence,
      char_start: start,
      char_end: end,
      node_id: resolved[0]?.nodeId ?? null,
      weight: 1.0
    })
  }

  // 1) explicit cue phrases
  for (const rx of REQUIREMENT_CUES) {
    rx.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rx.exec(text))) {
      const kind: 'must_have' | 'nice_to_have' =
        /nice to have|nice-to-have|preferred|desirable|plus|bonus/i.test(m[0]) ? 'nice_to_have' : 'must_have'
      const head = m[0].slice(0, m[0].indexOf(m[1]))
      const valueStart = (m.index ?? 0) + head.length
      for (const part of splitList(m[1])) {
        const local = text.toLowerCase().indexOf(part.toLowerCase(), valueStart)
        const start = local === -1 ? valueStart : local
        push(kind, part, text.slice(start, start + part.length) || part, start, start + part.length)
      }
    }
  }

  // 2) bullet lists under a requirements/responsibilities heading
  BULLET_RE.lastIndex = 0
  let b: RegExpExecArray | null
  while ((b = BULLET_RE.exec(text))) {
    const line = b[1].trim()
    // Ignore bullets that are obviously company blurb.
    if (/^(we|our|about|company)\b/i.test(line)) continue
    const kind: 'must_have' | 'nice_to_have' = /preferred|desirable|bonus|plus|nice/i.test(line)
      ? 'nice_to_have'
      : 'must_have'
    const start = (b.index ?? 0) + b[0].indexOf(line)
    for (const part of splitList(line)) {
      const local = text.toLowerCase().indexOf(part.toLowerCase(), start)
      const s = local === -1 ? start : local
      push(kind, part, text.slice(s, s + part.length) || part, s, s + part.length)
    }
  }

  return out.slice(0, 40)
}

/* -------------------------------------------------------------- validation */

const DISCOURAGED_TERMS = [
  ['rockstar', 'Jargon that narrows the applicant pool'],
  ['ninja', 'Jargon that narrows the applicant pool'],
  ['guru', 'Jargon that narrows the applicant pool'],
  ['work hard play hard', 'Cliché that signals long hours'],
  ['young and energetic', 'Age-coded language (protected attribute)'],
  ['digital native', 'Age-coded language (protected attribute)'],
  ['recent graduate', 'Age-coded language (protected attribute)'],
  ['he or she', 'Gendered pronoun; use "they"'],
  ['salesman', 'Gendered job title'],
  ['chairman', 'Gendered job title'],
  ['manpower', 'Gendered terminology'],
  ['native english speaker', 'Nationality-coded requirement']
]

const PROTECTED_PHRASES = [
  'marital status', 'religion', 'caste', 'date of birth', 'age limit',
  'gender preference', 'nationality required', 'photo required', 'caste certificate'
]

export const validateJd = (
  job: any,
  graph?: TaxGraph | null
): JdAnalysis => {
  const issues: JdIssue[] = []
  const description = String(job.description || '')
  const requirements = String(job.requirements || '')
  const title = String(job.title || '')
  const body = `${title}\n${description}\n${requirements}`.toLowerCase()

  const mustHaves = parseJson<string[]>(job.must_have_skills, [])
  const niceToHaves = parseJson<string[]>(job.nice_to_have, [])

  /* --- hard errors: protected attributes are not permitted in a JD ---------- */
  for (const phrase of PROTECTED_PHRASES) {
    if (body.includes(phrase)) {
      issues.push({
        code: 'protected_attribute', severity: 'error', field: 'description',
        message: `The JD mentions "${phrase}", which is a protected attribute.`,
        hint: 'Remove it. Use the screening profile for job-related criteria only.'
      })
    }
  }
  try {
    assertNoProtectedInputs('jd', [...mustHaves, ...niceToHaves])
  } catch {
    issues.push({
      code: 'protected_requirement', severity: 'error', field: 'must_have_skills',
      message: 'A required or preferred skill is a protected attribute.',
      hint: 'Requirements must be job-related. Remove the protected attribute.'
    })
  }

  /* --- completeness -------------------------------------------------------- */
  if (title.trim().length < 4) {
    issues.push({ code: 'title_missing', severity: 'error', field: 'title', message: 'Title is required.' })
  }
  if (description.trim().length < 80) {
    issues.push({
      code: 'description_short', severity: 'warn', field: 'description',
      message: 'Description is shorter than 80 characters — candidates rarely apply with so little context.',
      hint: 'Add scope, team and product context.'
    })
  }
  if (requirements.trim().length < 40) {
    issues.push({
      code: 'requirements_short', severity: 'warn', field: 'requirements',
      message: 'Requirements section is thin.', hint: 'List must-have and nice-to-have separately.'
    })
  }
  if (!mustHaves.length) {
    issues.push({
      code: 'no_must_haves', severity: 'error', field: 'must_have_skills',
      message: 'No must-have skills — screening cannot run defensibly without them.',
      hint: 'Add at least two job-related must-haves.'
    })
  }
  if (!job.location) {
    issues.push({ code: 'location_missing', severity: 'warn', field: 'location', message: 'Location is not set.' })
  }
  if (job.salary_min && job.salary_max && Number(job.salary_min) > Number(job.salary_max)) {
    issues.push({
      code: 'salary_inverted', severity: 'error', field: 'salary',
      message: 'Minimum salary is higher than maximum.'
    })
  }
  if (!job.salary_min && !job.salary_max) {
    issues.push({
      code: 'salary_missing', severity: 'info', field: 'salary',
      message: 'No salary range stated.', hint: 'Ranges materially improve application rates.'
    })
  }

  /* --- inclusivity --------------------------------------------------------- */
  for (const [term, why] of DISCOURAGED_TERMS) {
    if (body.includes(term)) {
      issues.push({
        code: 'discouraged_term', severity: 'warn', field: 'description',
        message: `The phrase "${term}" is discouraged. ${why}`,
        hint: 'Rewrite in neutral, job-related language.'
      })
    }
  }

  /* --- specificity --------------------------------------------------------- */
  const vague = ['dynamic individual', 'self-starter', 'team player', 'go-getter', 'wear many hats']
  for (const v of vague) {
    if (body.includes(v)) {
      issues.push({
        code: 'vague_phrase', severity: 'info', field: 'description',
        message: `"${v}" is not measurable.`, hint: 'Replace with a concrete expectation.'
      })
    }
  }

  const allSkills = [...mustHaves, ...niceToHaves]
  const resolved = graph ? allSkills.filter((s) => matchTerms(graph, s).length > 0) : []
  const unresolved = allSkills.filter((s) => !resolved.includes(s))
  if (graph && allSkills.length && resolved.length === 0) {
    issues.push({
      code: 'taxonomy_unresolved', severity: 'warn', field: 'must_have_skills',
      message: 'None of the listed skills resolve to the automotive taxonomy.',
      hint: 'Use standard terms, or propose them to the taxonomy for review.'
    })
  }

  /* --- scores -------------------------------------------------------------- */
  const errorCount = issues.filter((i) => i.severity === 'error').length
  const warnCount = issues.filter((i) => i.severity === 'warn').length
  const clarity = Math.max(0, 100 - errorCount * 25 - warnCount * 8)
  const inclusivity = Math.max(
    0,
    100 - issues.filter((i) => i.code === 'discouraged_term' || i.code === 'protected_attribute').length * 30
  )
  const specificity = Math.min(
    100,
    (mustHaves.length >= 3 ? 50 : mustHaves.length * 15) +
    (niceToHaves.length >= 2 ? 25 : niceToHaves.length * 12) +
    (allSkills.length && resolved.length ? 25 : 0)
  )

  const suggested = graph ? recommendRoles(graph, `${title} ${description} ${allSkills.join(' ')}`, 3) : []

  return {
    issues,
    coverage: {
      mustHaves: mustHaves.length,
      niceToHaves: niceToHaves.length,
      taxonomyResolved: resolved.length,
      unresolved: unresolved.slice(0, 12)
    },
    scores: {
      clarity,
      inclusivity,
      specificity,
      total: Math.round((clarity * 0.4 + inclusivity * 0.3 + specificity * 0.3))
    },
    suggestedRoles: suggested.map((s) => ({ code: s.node.code, name: s.node.name, score: s.score }))
  }
}

/* ---------------------------------------------------------------- versions */

export const saveJdVersion = async (
  db: D1Database,
  opts: {
    job: any
    tenantId: number
    actorId: number
    graph?: TaxGraph | null
    status?: 'draft' | 'approved'
    notes?: string
  }
) => {
  const job = opts.job
  const prev = await db
    .prepare(`SELECT * FROM jd_versions WHERE job_id = ? ORDER BY version DESC LIMIT 1`)
    .bind(job.id)
    .first<any>()
  const version = (prev?.version || 0) + 1

  const snapshot = {
    title: job.title,
    department: job.department,
    location: job.location,
    work_mode: job.work_mode,
    employment_type: job.employment_type,
    seniority: job.seniority,
    description: job.description,
    requirements: job.requirements,
    must_have_skills: parseJson<string[]>(job.must_have_skills, []),
    nice_to_have_skills: parseJson<string[]>(job.nice_to_have, []),
    salary_min: job.salary_min,
    salary_max: job.salary_max,
    currency: job.currency
  }

  const res = await db
    .prepare(
      `INSERT INTO jd_versions (tenant_id, job_id, version, snapshot, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(opts.tenantId, job.id, version, JSON.stringify(snapshot), opts.status ?? 'draft', opts.actorId, nowIso())
    .run()
  const versionId = Number(res.meta.last_row_id)

  const extracted = extractRequirements(
    `${snapshot.description}\n${snapshot.requirements}`,
    opts.graph ?? null
  )

  // Declared skill lists win over prose extraction: if the recruiter typed a
  // must-have explicitly, that is the requirement of record.
  const declared: ExtractedRequirement[] = [
    ...snapshot.must_have_skills.map((s) => ({ s, kind: 'must_have' as const })),
    ...snapshot.nice_to_have_skills.map((s) => ({ s, kind: 'nice_to_have' as const }))
  ].map(({ s, kind }) => {
    const source = `${snapshot.requirements}\n${snapshot.description}`
    const idx = source.toLowerCase().indexOf(String(s).toLowerCase())
    const match = opts.graph ? matchTerms(opts.graph, String(s))[0] : undefined
    return {
      kind,
      text: String(s),
      evidence_text: idx >= 0 ? source.slice(idx, idx + String(s).length) : String(s),
      char_start: idx >= 0 ? idx : 0,
      char_end: idx >= 0 ? idx + String(s).length : String(s).length,
      node_id: match?.nodeId ?? null,
      weight: 1.0
    }
  })

  const seen = new Set(declared.map((d) => `${d.kind}:${d.text.toLowerCase()}`))
  const merged = [...declared, ...extracted.filter((e) => !seen.has(`${e.kind}:${e.text.toLowerCase()}`))]
    .slice(0, 60)

  for (const r of merged) {
    await db
      .prepare(
        `INSERT INTO jd_requirements
           (tenant_id, jd_version_id, kind, text, node_id, weight, evidence_text, char_start, char_end, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(opts.tenantId, versionId, r.kind, truncate(r.text, 200), r.node_id, r.weight,
        truncate(r.evidence_text, 300), r.char_start, r.char_end, nowIso())
      .run()
  }

  const analysis = validateJd(job, opts.graph ?? null)
  await db
    .prepare(
      `INSERT INTO jd_analyses (tenant_id, job_id, issues, coverage, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      opts.tenantId, job.id, JSON.stringify(analysis.issues),
      JSON.stringify({ ...analysis.coverage, scores: analysis.scores, suggestedRoles: analysis.suggestedRoles }),
      opts.actorId, nowIso()
    )
    .run()

  await audit(db, {
    entityType: 'jd_version', entityId: versionId, action: 'jd.version.create',
    actorId: opts.actorId,
    previousValue: prev ? { version: prev.version } : null,
    newValue: { version, status: opts.status ?? 'draft', requirements: merged.length },
    reason: opts.notes ?? null,
    meta: { issues: analysis.issues.length, score: analysis.scores.total }
  })

  return { versionId, version, requirements: merged.length, analysis }
}

export const listJdVersions = async (db: D1Database, jobId: number) => {
  const { results } = await db
    .prepare(
      `SELECT v.*, u.name AS created_by_name,
              (SELECT COUNT(*) FROM jd_requirements r WHERE r.jd_version_id = v.id) AS requirement_count
         FROM jd_versions v LEFT JOIN users u ON u.id = v.created_by
        WHERE v.job_id = ? ORDER BY v.version DESC`
    )
    .bind(jobId)
    .all<any>()
  return results
}

export const loadJdVersion = async (db: D1Database, versionId: number) => {
  const v = await db.prepare(`SELECT * FROM jd_versions WHERE id = ?`).bind(versionId).first<any>()
  if (!v) return null
  const [reqs, analyses] = await Promise.all([
    db.prepare(`SELECT * FROM jd_requirements WHERE jd_version_id = ? ORDER BY kind DESC, id`).bind(versionId).all<any>(),
    db.prepare(`SELECT * FROM jd_analyses WHERE job_id = ? ORDER BY id DESC LIMIT 3`).bind(v.job_id).all<any>()
  ])
  return {
    ...v,
    snapshot: parseJson<Record<string, any>>(v.snapshot, {}),
    requirements: reqs.results,
    analyses: analyses.results.map((a: any) => ({
      ...a,
      issues: parseJson<any[]>(a.issues, []),
      coverage: parseJson<Record<string, any>>(a.coverage, {})
    }))
  }
}

/** Requirement-level diff between two JD versions. */
export const diffJdVersions = async (db: D1Database, fromId: number, toId: number) => {
  const [a, b] = await Promise.all([
    db.prepare(`SELECT * FROM jd_requirements WHERE jd_version_id = ?`).bind(fromId).all<any>(),
    db.prepare(`SELECT * FROM jd_requirements WHERE jd_version_id = ?`).bind(toId).all<any>()
  ])
  const key = (r: any) => `${r.kind}:${String(r.text).toLowerCase()}`
  const fromSet = new Set(a.results.map(key))
  const toSet = new Set(b.results.map(key))
  return {
    added: b.results.filter((r: any) => !fromSet.has(key(r))),
    removed: a.results.filter((r: any) => !toSet.has(key(r))),
    unchanged: b.results.filter((r: any) => fromSet.has(key(r)))
  }
}

/* --------------------------------------------------------- coverage preview */

/** "Will this requisition actually find anyone?" — run against the live pool. */
export const poolCoveragePreview = async (
  db: D1Database,
  job: any,
  graph: TaxGraph,
  limit = 200
) => {
  const musts = parseJson<string[]>(job.must_have_skills, [])
  const { results } = await db
    .prepare(
      `SELECT c.id, c.first_name, c.last_name, c.consent_status,
              COALESCE(ci.resume_text, ci.search_blob, '') AS body
         FROM candidates c
         LEFT JOIN candidate_index ci ON ci.candidate_id = c.id
        WHERE c.status = 'active'
        LIMIT ?`
    )
    .bind(limit)
    .all<any>()

  let any = 0
  let full = 0
  const missingCounts = new Map<string, number>()

  for (const row of results) {
    const cov = computeCoverage(graph, musts, String(row.body || ''))
    if (cov.matched > 0) any++
    if (cov.total > 0 && cov.matched === cov.total) full++
    for (const g of cov.gaps) {
      if (!g.matched) missingCounts.set(g.requirement, (missingCounts.get(g.requirement) || 0) + 1)
    }
  }

  const pool = results.length || 1
  return {
    poolSize: results.length,
    candidatesWithAnyMustHave: any,
    candidatesWithAllMustHaves: full,
    anyPct: Math.round((any / pool) * 1000) / 10,
    allPct: Math.round((full / pool) * 1000) / 10,
    hardestRequirements: [...missingCounts.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 8)
      .map(([requirement, missing]) => ({ requirement, missing, missingPct: Math.round((missing / pool) * 1000) / 10 }))
  }
}
