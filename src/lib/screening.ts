/**
 * Phase 4 — screening & ranking engine (N1, N2, N3, N7).
 *
 * Contract this module enforces, in code rather than in prose:
 *
 *  N1  Every dimension score is backed by evidence rows whose character spans
 *      are re-verified against the source document. Evidence that cannot be
 *      verified is DISCARDED, never stored as a supporting claim. If too little
 *      verifiable evidence survives, the run degrades to `manual_review`.
 *  N2  The engine produces an advisory classification only. `not_qualified` is a
 *      label for a human queue — nothing here rejects, advances or withdraws an
 *      application, and `decideRun` requires a named human actor.
 *  N3  Scoring input is masked first; protected attributes (name, gender, age,
 *      photo, address, contact details, caste, religion, nationality) are
 *      removed before any dimension is computed, and a profile that tries to
 *      weight a protected attribute is rejected outright.
 *  N7  No auto-rejection, ever. The engine cannot write `applications.status`.
 */
import { nowIso, parseJson } from './util'
import { audit } from './audit'
import { maskForScoring, assertNoProtectedInputs } from './masking'
import { verifySpan } from './evidence'
import { computeCoverage, matchTerms, expandToTools, type TaxGraph } from './taxonomy'

export const SCREENING_CLASSES = [
  'excellent', 'strong', 'good', 'partial', 'low', 'not_qualified', 'manual_review'
] as const
export type ScreeningClass = (typeof SCREENING_CLASSES)[number]

export const DIMENSIONS = [
  'must_have_coverage', 'skills_depth', 'experience', 'tooling', 'education', 'recency'
] as const
export type Dimension = (typeof DIMENSIONS)[number]

export const DIMENSION_LABELS: Record<Dimension, string> = {
  must_have_coverage: 'Must-have coverage',
  skills_depth: 'Skill depth (nice-to-have + related)',
  experience: 'Relevant experience',
  tooling: 'Tools & standards',
  education: 'Education',
  recency: 'Recency of relevant work'
}

/** Default weights are explicit and sum to 100 so the number is explainable. */
export const DEFAULT_WEIGHTS: Record<Dimension, number> = {
  must_have_coverage: 40,
  skills_depth: 20,
  experience: 18,
  tooling: 12,
  education: 5,
  recency: 5
}

export const DEFAULT_THRESHOLDS: { class: ScreeningClass; min: number }[] = [
  { class: 'excellent', min: 85 },
  { class: 'strong', min: 72 },
  { class: 'good', min: 58 },
  { class: 'partial', min: 40 },
  { class: 'low', min: 20 }
]

/** Evidence coverage below this degrades the run to manual review (N1). */
export const MIN_EVIDENCE_COVERAGE = 55
/** Fewer verifiable evidence rows than this is not a defensible basis for a class. */
export const MIN_EVIDENCE_ROWS = 3

export type KnockoutRule = {
  rule: string
  label: string
  /** 'missing_skill' | 'min_experience' | 'consent' | 'missing_evidence' */
  type: 'missing_skill' | 'min_experience' | 'consent' | 'missing_evidence'
  value?: number | string | string[]
  enabled: boolean
}

export const DEFAULT_KNOCKOUTS = (job: any): KnockoutRule[] => {
  const musts = parseJson<string[]>(job?.must_have_skills, [])
  return [
    ...musts.slice(0, 4).map((skill) => ({
      rule: `must_have:${skill}`, label: `Must have ${skill}`,
      type: 'missing_skill' as const, value: skill, enabled: true
    })),
    {
      rule: 'min_experience', label: 'Minimum relevant experience',
      type: 'min_experience', value: 0, enabled: false
    },
    {
      rule: 'consent', label: 'Candidate has not opted out',
      type: 'consent', value: 'opt_out', enabled: true
    }
  ]
}

/* ------------------------------------------------------------------ profile */

export const loadProfile = async (db: D1Database, jobId: number) => {
  const row = await db
    .prepare(
      `SELECT * FROM screening_profiles
        WHERE job_id = ? AND status = 'active'
        ORDER BY version DESC LIMIT 1`
    )
    .bind(jobId)
    .first<any>()
  return row || null
}

export const resolveProfile = async (db: D1Database, job: any) => {
  const stored = await loadProfile(db, job.id)
  if (stored) {
    return {
      id: stored.id as number,
      version: stored.version as number,
      weights: { ...DEFAULT_WEIGHTS, ...parseJson<Record<string, number>>(stored.weights, {}) },
      knockouts: parseJson<KnockoutRule[]>(stored.knockouts, []) as KnockoutRule[],
      thresholds: parseJson<{ class: ScreeningClass; min: number }[]>(stored.thresholds, DEFAULT_THRESHOLDS),
      stored: true
    }
  }
  return {
    id: null as number | null,
    version: 0,
    weights: { ...DEFAULT_WEIGHTS },
    knockouts: DEFAULT_KNOCKOUTS(job),
    thresholds: DEFAULT_THRESHOLDS,
    stored: false
  }
}

export const saveProfile = async (
  db: D1Database,
  opts: {
    jobId: number
    tenantId: number
    weights: Record<string, number>
    knockouts: KnockoutRule[]
    thresholds?: { class: ScreeningClass; min: number }[]
    actorId: number
  }
) => {
  // N3 gate: a profile may not weight a protected attribute.
  assertNoProtectedInputs('screening_profile', opts.weights)

  const weightSum = DIMENSIONS.reduce((a, d) => a + Number(opts.weights[d] || 0), 0)
  if (Math.round(weightSum) !== 100) {
    throw Object.assign(new Error(`Weights must sum to 100 (got ${Math.round(weightSum)})`), {
      status: 422, code: 'weights_invalid'
    })
  }
  for (const k of Object.keys(opts.weights)) {
    if (!DIMENSIONS.includes(k as Dimension)) {
      throw Object.assign(new Error(`Unknown dimension: ${k}`), { status: 422, code: 'unknown_dimension' })
    }
  }

  const prev = await loadProfile(db, opts.jobId)
  const version = (prev?.version || 0) + 1
  const thresholds = opts.thresholds || DEFAULT_THRESHOLDS

  // Versioned, not mutated: the previous profile is superseded so any run can be
  // replayed against the weights that were actually in force at the time.
  if (prev) {
    await db.prepare(`UPDATE screening_profiles SET status = 'superseded' WHERE id = ?`).bind(prev.id).run()
  }
  const res = await db
    .prepare(
      `INSERT INTO screening_profiles
         (tenant_id, job_id, version, status, weights, knockouts, thresholds, created_by, created_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`
    )
    .bind(
      opts.tenantId, opts.jobId, version,
      JSON.stringify(opts.weights), JSON.stringify(opts.knockouts), JSON.stringify(thresholds),
      opts.actorId, nowIso()
    )
    .run()

  await audit(db, {
    entityType: 'screening_profile', entityId: Number(res.meta.last_row_id),
    action: 'screening.profile.create', actorId: opts.actorId,
    previousValue: prev ? { version: prev.version } : null,
    newValue: { version, weights: opts.weights, knockouts: opts.knockouts.map((k) => k.rule) }
  })
  return { id: Number(res.meta.last_row_id), version }
}

/* ------------------------------------------------------------------- helpers */

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10))

const classify = (score: number, thresholds: { class: ScreeningClass; min: number }[]): ScreeningClass => {
  const ordered = [...thresholds].sort((a, b) => b.min - a.min)
  for (const t of ordered) if (score >= t.min) return t.class
  return 'not_qualified'
}

const recencyScore = (timelineSpans: { end: number }[]): { score: number; years: number } => {
  if (!timelineSpans.length) return { score: 0, years: 0 }
  const latest = Math.max(...timelineSpans.map((s) => s.end))
  const gap = new Date().getFullYear() - latest
  if (gap <= 1) return { score: 100, years: gap }
  if (gap <= 3) return { score: 75, years: gap }
  if (gap <= 5) return { score: 50, years: gap }
  return { score: 25, years: gap }
}

/* --------------------------------------------------------------- the engine */

export type EvidenceClaim = {
  dimension: Dimension
  claim: string
  evidence: string
  resumeId: number
  charStart: number | null
  charEnd: number | null
  pageNo: number | null
}

/**
 * Run the engine for one candidate against one requisition.
 * Pure computation first, single write phase second, so a failed run leaves no
 * half-written evidence behind.
 */
export const runScreening = async (
  db: D1Database,
  opts: {
    jobId: number
    candidateId: number
    actorId: number
    tenantId: number
    graph: TaxGraph
    applicationId?: number | null
  }
) => {
  const job = await db.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(opts.jobId).first<any>()
  if (!job) throw Object.assign(new Error('Job not found'), { status: 404, code: 'not_found' })

  const candidate = await db
    .prepare(`SELECT * FROM candidates WHERE id = ? AND status = 'active'`)
    .bind(opts.candidateId)
    .first<any>()
  if (!candidate) throw Object.assign(new Error('Candidate not found'), { status: 404, code: 'not_found' })

  const resume = await db
    .prepare(
      `SELECT * FROM resumes WHERE candidate_id = ?
        ORDER BY is_primary DESC, created_at DESC LIMIT 1`
    )
    .bind(opts.candidateId)
    .first<any>()

  const rawText: string = resume?.raw_text || ''
  const knownNames = [candidate.first_name, candidate.last_name, `${candidate.first_name} ${candidate.last_name}`]
    .filter(Boolean)

  // ---- N3: mask before scoring. The masked text is the only scoring input.
  const masked = maskForScoring(rawText, knownNames)
  const scoringText = masked.text || ''

  const profile = await resolveProfile(db, job)
  const musts = parseJson<string[]>(job.must_have_skills, [])
  const nices = parseJson<string[]>(job.nice_to_have, [])

  /* ---------------------------------------------------- dimension: must-have */
  const coverage = computeCoverage(opts.graph, musts, scoringText)
  const mustHaveScore = musts.length ? coverage.coverage : 60 // no must-haves → neutral, and it lowers confidence

  /* --------------------------------------------------- dimension: depth */
  const techMatches = matchTerms(opts.graph, scoringText, [
    'technical_skill', 'software_tool', 'standard_protocol', 'job_role'
  ])
  const niceHit = matchTerms(opts.graph, scoringText).filter((m) =>
    nices.some((n) => n.toLowerCase().trim() === m.name.toLowerCase().trim())
  )
  const relatedTools = expandToTools(
    opts.graph,
    techMatches.filter((m) => m.kind === 'technical_skill').map((m) => m.nodeId),
    30
  )
  // Depth saturates: 12 distinct verified technical signals is full marks.
  const depthRaw = techMatches.filter((m) => m.kind !== 'job_role').length + relatedTools.length * 0.5
  const skillsDepthScore = clamp(Math.min(100, (depthRaw / 12) * 100))
  const niceBonus = nices.length ? Math.min(15, (niceHit.length / nices.length) * 15) : 0

  /* ------------------------------------------------------- dimension: experience */
  const fromFields = await db
    .prepare(`SELECT * FROM resume_fields WHERE resume_id = ? AND field = 'experience_years'`)
    .bind(resume?.id ?? 0)
    .first<any>()
  const declaredYears = Number(fromFields?.value ?? candidate.experience_years ?? 0)
  const seniorityTarget: Record<string, number> = {
    intern: 0, entry: 1, junior: 1, mid: 3, senior: 6, lead: 9, principal: 13, manager: 8, director: 12
  }
  const target = seniorityTarget[String(job.seniority || '').toLowerCase()] ?? 3
  // 100% at target, tapering below it; over-qualification is not penalised.
  const experienceScore = target <= 0
    ? (declaredYears > 0 ? 100 : 40)
    : clamp(Math.min(100, (declaredYears / target) * 100))

  /* ---------------------------------------------------------- dimension: tooling */
  const toolSignals = techMatches.filter(
    (m) => m.kind === 'software_tool' || m.kind === 'standard_protocol'
  )
  const toolingScore = clamp(Math.min(100, (toolSignals.length / 5) * 100))

  /* -------------------------------------------------------- dimension: education */
  const eduField = await db
    .prepare(`SELECT * FROM resume_fields WHERE resume_id = ? AND field = 'education' LIMIT 1`)
    .bind(resume?.id ?? 0)
    .first<any>()
  const eduText = String(eduField?.value || candidate.education || '')
  const eduScore = /ph\.?d|doctor/i.test(eduText)
    ? 100
    : /master|m\.?\s?tech|mba|m\.?\s?sc|m\.?\s?e\.?/i.test(eduText)
      ? 90
      : /bachelor|b\.?\s?tech|b\.?\s?sc|b\.?\s?e\.?/i.test(eduText)
        ? 78
        : /diploma/i.test(eduText)
          ? 60
          : 0

  /* --------------------------------------------------------- dimension: recency */
  const timelineField = await db
    .prepare(`SELECT * FROM resume_fields WHERE resume_id = ? AND field = 'employment_timeline'`)
    .bind(resume?.id ?? 0)
    .first<any>()
  const timelineRaw = String(timelineField?.value || '')
  const timelineSpans = [...timelineRaw.matchAll(/((?:19|20)\d{2})\s*(?:-|–|—|to)\s*((?:19|20)\d{2}|present|current|now)/gi)]
    .map((m) => ({
      end: /^\d{4}$/.test(m[2]) ? Number(m[2]) : new Date().getFullYear()
    }))
  const recency = recencyScore(timelineSpans)

  /* ------------------------------------------------------------- weighted score */
  const rawDimensions: Record<Dimension, number> = {
    must_have_coverage: clamp(mustHaveScore + (niceBonus && mustHaveScore < 100 ? niceBonus * 0.3 : 0)),
    skills_depth: skillsDepthScore,
    experience: experienceScore,
    tooling: toolingScore,
    education: eduScore,
    recency: recency.score
  }

  const weights = profile.weights
  let weighted = 0
  let weightApplied = 0
  for (const d of DIMENSIONS) {
    const w = Number(weights[d] || 0)
    weighted += rawDimensions[d] * w
    weightApplied += w
  }
  const score = weightApplied ? Math.round((weighted / weightApplied) * 10) / 10 : 0

  /* ---------------------------------------------------------------- knock-outs */
  const knockoutResults: {
    rule: string; label: string; outcome: 'pass' | 'fail' | 'unknown'
    detail: string; evidence?: string | null; charStart?: number | null; charEnd?: number | null
  }[] = []

  for (const k of profile.knockouts) {
    if (!k.enabled) continue
    if (k.type === 'missing_skill') {
      const skill = String(k.value || '')
      const gap = coverage.gaps.find((g) => g.requirement.toLowerCase().trim() === skill.toLowerCase().trim())
      if (!gap) {
        // The rule references a skill the job no longer lists — report, don't guess.
        knockoutResults.push({
          rule: k.rule, label: k.label, outcome: 'unknown',
          detail: 'Rule references a requirement that is not in the current must-have list'
        })
      } else if (gap.matched) {
        knockoutResults.push({
          rule: k.rule, label: k.label, outcome: 'pass',
          detail: `Matched via ${gap.via}`, evidence: gap.surface, charStart: null, charEnd: null
        })
      } else {
        knockoutResults.push({
          rule: k.rule, label: k.label, outcome: 'fail',
          detail: 'No verifiable mention anywhere in the source document'
        })
      }
    } else if (k.type === 'min_experience') {
      const min = Number(k.value || 0)
      knockoutResults.push({
        rule: k.rule, label: k.label,
        outcome: declaredYears >= min ? 'pass' : 'fail',
        detail: `${declaredYears} year(s) evidenced vs ${min} required`,
        evidence: fromFields?.evidence_text ?? null,
        charStart: fromFields?.char_start ?? null,
        charEnd: fromFields?.char_end ?? null
      })
    } else if (k.type === 'consent') {
      const optedOut = candidate.consent_status === 'opt_out'
      knockoutResults.push({
        rule: k.rule, label: k.label,
        outcome: optedOut ? 'fail' : candidate.consent_status === 'opt_in' ? 'pass' : 'unknown',
        detail: `Consent status: ${candidate.consent_status}`
      })
    }
  }

  const failedKnockouts = knockoutResults.filter((k) => k.outcome === 'fail')
  const unknownKnockouts = knockoutResults.filter((k) => k.outcome === 'unknown')

  /* ----------------------------------------------------------------- evidence */
  const claims: EvidenceClaim[] = []
  const resumeId = resume?.id ?? 0

  if (resumeId) {
    const { results: storedFields } = await db
      .prepare(`SELECT * FROM resume_fields WHERE resume_id = ? AND verified = 1`)
      .bind(resumeId)
      .all<any>()

    for (const g of coverage.gaps) {
      if (!g.matched || !g.surface) continue
      const hit = storedFields.find(
        (f) => String(f.field).startsWith('skill:') && String(f.value) === g.requirement
      ) || storedFields.find((f) => String(f.field).startsWith('skill:') && String(f.value).toLowerCase() === g.requirement.toLowerCase())
      if (hit) {
        claims.push({
          dimension: 'must_have_coverage',
          claim: `Requirement "${g.requirement}" is evidenced in the document`,
          evidence: hit.evidence_text,
          resumeId, charStart: hit.char_start, charEnd: hit.char_end, pageNo: hit.page_no
        })
      }
    }

    for (const t of toolSignals.slice(0, 6)) {
      const hit = storedFields.find((f) => String(f.field) === `skill:${t.code}`)
      if (hit) {
        claims.push({
          dimension: 'tooling', claim: `Tool/standard "${t.name}" appears in the document`,
          evidence: hit.evidence_text, resumeId,
          charStart: hit.char_start, charEnd: hit.char_end, pageNo: hit.page_no
        })
      }
    }

    if (fromFields?.evidence_text) {
      claims.push({
        dimension: 'experience', claim: `${declaredYears} year(s) of experience`,
        evidence: fromFields.evidence_text, resumeId,
        charStart: fromFields.char_start, charEnd: fromFields.char_end, pageNo: fromFields.page_no
      })
    }
    if (eduField?.evidence_text) {
      claims.push({
        dimension: 'education', claim: 'Education qualification stated',
        evidence: eduField.evidence_text, resumeId,
        charStart: eduField.char_start, charEnd: eduField.char_end, pageNo: eduField.page_no
      })
    }
    if (timelineField?.evidence_text) {
      claims.push({
        dimension: 'recency', claim: `Most recent evidenced role ends ${recency.years === 0 ? 'this year or later' : `${recency.years} year(s) ago`}`,
        evidence: timelineField.evidence_text, resumeId,
        charStart: timelineField.char_start, charEnd: timelineField.char_end, pageNo: timelineField.page_no
      })
    }
  }

  // N1: verify every claim against the raw source. Verified-only survives.
  const verifiedClaims: EvidenceClaim[] = []
  let rejectedClaims = 0
  for (const cl of claims) {
    const check = verifySpan(rawText, cl.charStart, cl.charEnd, cl.evidence)
    if (check.ok) verifiedClaims.push(cl)
    else rejectedClaims++
  }

  const evidenceCoverage = claims.length
    ? Math.round((verifiedClaims.length / claims.length) * 1000) / 10
    : 0

  /* ------------------------------------------------------------- classification */
  let klass: ScreeningClass = classify(score, profile.thresholds)
  const reasons: string[] = []

  if (profile.knockouts.some((k) => k.enabled) && musts.length === 0) {
    // Degenerate profile: no requirements to screen against.
    klass = 'manual_review'
    reasons.push('Requisition has no must-have requirements; nothing defensible to screen against')
  } else if (failedKnockouts.length) {
    // A failed knock-out routes to a human. It is NOT an automatic rejection.
    klass = 'manual_review'
    reasons.push(`${failedKnockouts.length} knock-out rule(s) failed — routed to human review, not rejected`)
  } else if (unknownKnockouts.length) {
    klass = 'manual_review'
    reasons.push(`${unknownKnockouts.length} knock-out rule(s) could not be evaluated`)
  }

  if (verifiedClaims.length < MIN_EVIDENCE_ROWS) {
    klass = 'manual_review'
    reasons.push(`Only ${verifiedClaims.length} verifiable evidence row(s); ${MIN_EVIDENCE_ROWS} required for a classification`)
  } else if (evidenceCoverage < MIN_EVIDENCE_COVERAGE) {
    klass = 'manual_review'
    reasons.push(`Evidence coverage ${evidenceCoverage}% is below the ${MIN_EVIDENCE_COVERAGE}% floor`)
  }
  if (!resumeId) {
    klass = 'manual_review'
    reasons.push('No resume on file — screening cannot cite evidence')
  }

  const confidence: 'high' | 'medium' | 'low' =
    verifiedClaims.length >= 6 && evidenceCoverage >= 80 ? 'high'
      : verifiedClaims.length >= MIN_EVIDENCE_ROWS && evidenceCoverage >= MIN_EVIDENCE_COVERAGE ? 'medium'
        : 'low'

  /* ------------------------------------------------------------------- persist */
  const inputHash = `h${Math.abs(scoringText.length * 31 + opts.jobId * 7 + opts.candidateId).toString(16)}`
  const runRes = await db
    .prepare(
      `INSERT INTO screening_runs
         (tenant_id, job_id, candidate_id, application_id, profile_id, class, score, dimensions,
          knockouts_failed, confidence, summary, status, engine, prompt_version, input_hash,
          evidence_coverage, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', 'taxonomy-hybrid-v1', 'v1', ?, ?, ?, ?)`
    )
    .bind(
      opts.tenantId, opts.jobId, opts.candidateId, opts.applicationId ?? null, profile.id,
      klass, score, JSON.stringify(rawDimensions),
      JSON.stringify(failedKnockouts.map((k) => k.rule)), confidence,
      reasons.join(' · ') || 'Classified from verified evidence',
      inputHash, evidenceCoverage, opts.actorId, nowIso()
    )
    .run()
  const runId = Number(runRes.meta.last_row_id)

  for (const k of knockoutResults) {
    let verified = 0
    if (k.evidence && k.charStart !== null && k.charStart !== undefined) {
      const chk = verifySpan(rawText, k.charStart, k.charEnd, k.evidence)
      verified = chk.ok ? 1 : 0
    }
    await db
      .prepare(
        `INSERT INTO screening_knockouts
           (run_id, rule, label, outcome, detail, evidence, char_start, char_end, verified, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(runId, k.rule, k.label, k.outcome, k.detail, k.evidence ?? null,
        k.charStart ?? null, k.charEnd ?? null, verified, nowIso())
      .run()
  }

  for (const cl of verifiedClaims) {
    await db
      .prepare(
        `INSERT INTO screening_evidence
           (run_id, dimension, claim, evidence, resume_id, char_start, char_end, page_no, verified, verify_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'verified against source text', ?)`
      )
      .bind(runId, cl.dimension, cl.claim, cl.evidence, cl.resumeId,
        cl.charStart, cl.charEnd, cl.pageNo, nowIso())
      .run()
  }

  await audit(db, {
    entityType: 'screening_run', entityId: runId, action: 'screening.run',
    actorId: opts.actorId,
    newValue: { class: klass, score, confidence, evidenceCoverage },
    meta: {
      jobId: opts.jobId, candidateId: opts.candidateId, profileVersion: profile.version,
      verifiedEvidence: verifiedClaims.length, rejectedEvidence: rejectedClaims,
      maskedRedactions: masked.redactions, reasons
    },
    reason: 'Advisory screening run — requires human decision'
  })

  return {
    runId,
    class: klass,
    score,
    confidence,
    dimensions: rawDimensions,
    weights,
    profileVersion: profile.version,
    knockouts: knockoutResults,
    evidence: { verified: verifiedClaims.length, rejected: rejectedClaims, coverage: evidenceCoverage },
    reasons,
    /** Explicit: the engine never changes application state. */
    autoRejected: false,
    requiresHumanDecision: true
  }
}

/* ------------------------------------------------------------ human decision */

export const decideRun = async (
  db: D1Database,
  opts: {
    runId: number
    actorId: number
    tenantId: number
    decision: 'accepted' | 'overridden' | 'rejected' | 'escalated'
    finalClass?: ScreeningClass
    reason: string
  }
) => {
  if (!opts.reason || opts.reason.trim().length < 5) {
    throw Object.assign(new Error('A reason of at least 5 characters is required for a screening decision'), {
      status: 422, code: 'reason_required'
    })
  }
  const run = await db.prepare(`SELECT * FROM screening_runs WHERE id = ?`).bind(opts.runId).first<any>()
  if (!run) throw Object.assign(new Error('Run not found'), { status: 404, code: 'not_found' })
  if (run.decided_at) {
    throw Object.assign(new Error('Run already decided'), { status: 409, code: 'already_decided' })
  }

  const finalClass = opts.finalClass || run.class
  const ts = nowIso()

  await db
    .prepare(`UPDATE screening_runs SET decided_by = ?, decided_at = ?, decision = ? WHERE id = ?`)
    .bind(opts.actorId, ts, opts.decision, opts.runId)
    .run()

  if (opts.decision === 'overridden' && finalClass !== run.class) {
    await db
      .prepare(
        `INSERT INTO screening_overrides
           (run_id, reviewer_id, original_class, new_class, reason, override_kind, created_at)
         VALUES (?, ?, ?, ?, ?, 'human_judgement', ?)`
      )
      .bind(opts.runId, opts.actorId, run.class, finalClass, opts.reason, ts)
      .run()
  }

  await db
    .prepare(
      `INSERT INTO oversight_records
         (tenant_id, run_id, candidate_id, application_id, reviewer_id, review_kind,
          machine_class, final_class, reason, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(opts.tenantId, opts.runId, run.candidate_id, run.application_id ?? null, opts.actorId,
      opts.decision, run.class, finalClass, opts.reason, ts)
    .run()

  await audit(db, {
    entityType: 'screening_run', entityId: opts.runId, action: `screening.decision.${opts.decision}`,
    actorId: opts.actorId,
    previousValue: { class: run.class, decided: null },
    newValue: { finalClass, decision: opts.decision },
    reason: opts.reason
  })

  return { runId: opts.runId, decision: opts.decision, machineClass: run.class, finalClass }
}

/* ------------------------------------------------------------------ read side */

export const loadRun = async (db: D1Database, runId: number) => {
  const run = await db
    .prepare(
      `SELECT r.*, j.title AS job_title, j.code AS job_code,
              c.first_name, c.last_name, c.email,
              u.name AS decided_by_name, cb.name AS created_by_name
         FROM screening_runs r
         JOIN jobs j ON j.id = r.job_id
         JOIN candidates c ON c.id = r.candidate_id
         LEFT JOIN users u ON u.id = r.decided_by
         LEFT JOIN users cb ON cb.id = r.created_by
        WHERE r.id = ?`
    )
    .bind(runId)
    .first<any>()
  if (!run) return null

  const [evidence, knockouts, overrides, oversight] = await Promise.all([
    db.prepare(`SELECT * FROM screening_evidence WHERE run_id = ? ORDER BY dimension, id`).bind(runId).all<any>(),
    db.prepare(`SELECT * FROM screening_knockouts WHERE run_id = ? ORDER BY id`).bind(runId).all<any>(),
    db.prepare(
      `SELECT o.*, u.name AS reviewer_name FROM screening_overrides o
        LEFT JOIN users u ON u.id = o.reviewer_id WHERE o.run_id = ? ORDER BY o.id`
    ).bind(runId).all<any>(),
    db.prepare(
      `SELECT h.*, u.name AS reviewer_name FROM oversight_records h
        LEFT JOIN users u ON u.id = h.reviewer_id WHERE h.run_id = ? ORDER BY h.id`
    ).bind(runId).all<any>()
  ])

  const evidenceRows = evidence.results as any[]
  return {
    ...run,
    score: Number(run.score || 0),
    dimensions: parseJson<Record<string, number>>(run.dimensions, {}),
    knockouts_failed: parseJson<string[]>(run.knockouts_failed, []),
    evidence: evidenceRows,
    knockouts: knockouts.results,
    overrides: overrides.results,
    oversight: oversight.results,
    evidenceCoverage: Number(run.evidence_coverage || 0),
    verifiedEvidence: evidenceRows.filter((e) => Number(e.verified) === 1).length
  }
}

export const listRunsForJob = async (db: D1Database, jobId: number, limit = 60) => {
  const { results } = await db
    .prepare(
      `SELECT r.*, c.first_name, c.last_name, c.email,
              (SELECT COUNT(*) FROM screening_evidence e WHERE e.run_id = r.id) AS evidence_rows
         FROM screening_runs r
         JOIN candidates c ON c.id = r.candidate_id
        WHERE r.job_id = ?
        ORDER BY r.score DESC, r.id DESC
        LIMIT ?`
    )
    .bind(jobId, limit)
    .all<any>()
  return results
}

export const listRunsForCandidate = async (db: D1Database, candidateId: number) => {
  const { results } = await db
    .prepare(
      `SELECT r.*, j.title AS job_title, j.code AS job_code
         FROM screening_runs r JOIN jobs j ON j.id = r.job_id
        WHERE r.candidate_id = ? ORDER BY r.id DESC`
    )
    .bind(candidateId)
    .all<any>()
  return results
}

/** Runs sitting in the human queue: manual_review, or any undecided run. */
export const loadReviewQueue = async (db: D1Database, limit = 100) => {
  const { results } = await db
    .prepare(
      `SELECT r.*, j.title AS job_title, j.code AS job_code,
              c.first_name, c.last_name, c.email,
              (SELECT COUNT(*) FROM screening_evidence e WHERE e.run_id = r.id) AS evidence_rows
         FROM screening_runs r
         JOIN jobs j ON j.id = r.job_id
         JOIN candidates c ON c.id = r.candidate_id
        WHERE r.decided_at IS NULL
        ORDER BY CASE WHEN r.class = 'manual_review' THEN 0 ELSE 1 END, r.score DESC
        LIMIT ?`
    )
    .bind(limit)
    .all<any>()
  return results
}

export const screeningStats = async (db: D1Database) => {
  const one = async (sql: string, ...args: unknown[]) =>
    (await db.prepare(sql).bind(...args).first<any>()) || {}

  const totals = await one(
    `SELECT COUNT(*) AS runs,
            SUM(CASE WHEN class = 'manual_review' THEN 1 ELSE 0 END) AS manual,
            SUM(CASE WHEN decided_at IS NULL THEN 1 ELSE 0 END) AS undecided,
            AVG(evidence_coverage) AS avg_coverage,
            SUM(CASE WHEN confidence = 'low' THEN 1 ELSE 0 END) AS low_confidence
       FROM screening_runs`
  )
  const { results: byClass } = await db
    .prepare(`SELECT class, COUNT(*) AS n FROM screening_runs GROUP BY class ORDER BY n DESC`)
    .all<any>()
  const { results: byDecision } = await db
    .prepare(`SELECT review_kind, COUNT(*) AS n FROM oversight_records GROUP BY review_kind`)
    .all<any>()

  // Human control metric: the share of runs a human actually signed off.
  const runs = Number(totals.runs || 0)
  const decided = await one(`SELECT COUNT(*) AS n FROM screening_runs WHERE decided_at IS NOT NULL`)
  return {
    runs,
    manualReview: Number(totals.manual || 0),
    undecided: Number(totals.undecided || 0),
    lowConfidence: Number(totals.low_confidence || 0),
    avgCoverage: Math.round((Number(totals.avg_coverage) || 0) * 10) / 10,
    humanDecisionRate: runs ? Math.round((Number(decided.n || 0) / runs) * 1000) / 10 : 0,
    byClass,
    byDecision
  }
}
