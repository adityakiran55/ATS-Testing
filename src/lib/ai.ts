/**
 * ATS-12 / ATS-13 / ATS-14 / ATS-15 — deterministic assistive engine.
 *
 * Design constraints from the spec:
 *  - Output is *assistive*: never rejects, never auto-decides.
 *  - Every claim carries an evidence reference back to source data.
 *  - Missing information and confidence limits are surfaced explicitly.
 *  - Runs are persisted in ai_runs so output is traceable and reviewable.
 *
 * Implementation: TF-IDF style term overlap + rubric coverage. Deterministic and
 * fully explainable, so it can be unit tested without an external model.
 */
import { parseJson, truncate, hashString, nowIso } from './util'
import { expandQuery, synonymHint } from './search'

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'at', 'to', 'is', 'are', 'be'])

const terms = (s: string): string[] =>
  (s || '').toLowerCase().replace(/[^a-z0-9+#. ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w))

export type Evidence = { criterion: string; status: 'met' | 'partial' | 'missing'; quote?: string; source: string; weight: number }
export type AiRun = {
  engine: string
  confidence: number
  limitations: string[]
  missing_information: string[]
  evidence: Evidence[]
  output: Record<string, unknown>
}

const evidenceFor = (criterion: string, haystack: string, source: string): Evidence => {
  const lower = haystack.toLowerCase()
  const key = criterion.toLowerCase()
  const exact = lower.indexOf(key)
  if (exact >= 0) {
    const start = Math.max(0, exact - 60)
    return { criterion, status: 'met', quote: truncate(haystack.slice(start, exact + key.length + 80), 180), source, weight: 1 }
  }
  const parts = terms(criterion)
  const hits = parts.filter((p) => lower.includes(p))
  if (hits.length && hits.length >= Math.ceil(parts.length * 0.6)) {
    return {
      criterion,
      status: 'partial',
      quote: truncate(hits.join(', ') + ' mentioned in ' + source, 160),
      source,
      weight: 0.6
    }
  }
  return { criterion, status: 'missing', source, weight: 0 }
}

/** ATS-12 — candidate summary + side-by-side comparison against requisition criteria. */
export const summarizeCandidate = async (
  db: D1Database,
  candidateId: number,
  jobId?: number | null
): Promise<AiRun & { candidate: any; job?: any }> => {
  const cand = await db.prepare('SELECT * FROM candidates WHERE id = ?').bind(candidateId).first<any>()
  if (!cand) throw new Error('candidate_not_found')
  const idx = await db.prepare('SELECT * FROM candidate_index WHERE candidate_id = ?').bind(candidateId).first<any>()
  const resume = idx?.resume_text || cand.summary || ''
  const haystack = [idx?.skills, idx?.titles, idx?.employers, idx?.education, resume].filter(Boolean).join(' \n ')

  let job: any = null
  let criteria: string[] = []
  if (jobId) {
    job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<any>()
    const must = parseJson<string[]>(job?.must_have_skills, [])
    const nice = parseJson<string[]>(job?.nice_to_have, [])
    criteria = [...must, ...nice]
  }

  const evidence = criteria.map((c) => evidenceFor(c, haystack, 'resume/profile'))
  const met = evidence.filter((e) => e.status === 'met')
  const partial = evidence.filter((e) => e.status === 'partial')
  const missing = evidence.filter((e) => e.status === 'missing')
  const mustCount = job ? parseJson<string[]>(job.must_have_skills, []).length : 0
  const mustMet = evidence.slice(0, mustCount).filter((e) => e.status === 'met').length

  const scoreRaw = criteria.length
    ? (met.length + partial.length * 0.6) / criteria.length
    : 0.5
  const confidence = Math.min(0.95, 0.45 + (resume.length > 800 ? 0.3 : resume.length > 300 ? 0.18 : 0.05) + (criteria.length ? 0.1 : 0))

  const summaryParts: string[] = []
  if (cand.headline) summaryParts.push(`${cand.headline}.`)
  if (cand.experience_years) summaryParts.push(`${cand.experience_years} years of experience.`)
  if (cand.current_employer) summaryParts.push(`Currently at ${cand.current_employer}.`)
  if (job) {
    summaryParts.push(
      `Against "${job.title}": ${met.length}/${criteria.length} criteria evidenced, ${missing.length} missing${mustCount ? `, must-haves ${mustMet}/${mustCount}` : ''}.`
    )
  }

  const limitations = [
    'Derived from parsed resume text and profile fields only; no external verification performed.',
    'Scores are advisory and must be reviewed by a recruiter before any decision.'
  ]
  if (resume.length < 300) limitations.push('Resume text is sparse — parse quality limits confidence.')

  const missingInformation: string[] = []
  if (!cand.notice_period_days) missingInformation.push('notice period')
  if (!cand.expected_salary) missingInformation.push('salary expectation')
  if (!cand.location) missingInformation.push('location')
  if (job && missing.length) missingInformation.push(...missing.map((m) => `no evidence for "${m.criterion}"`))

  const output = {
    summary: summaryParts.join(' '),
    fit_score: Math.round(scoreRaw * 100),
    criteria_total: criteria.length,
    criteria_met: met.length,
    criteria_partial: partial.length,
    criteria_missing: missing.length,
    must_have_met: mustMet,
    strengths: met.map((m) => m.criterion),
    gaps: missing.map((m) => m.criterion)
  }

  await db
    .prepare(
      `INSERT INTO ai_runs (kind, entity_ref, engine, input_hash, output, created_at)
       VALUES ('summary', ?, 'rubric-evidence-v1', ?, ?, ?)`
    )
    .bind(`candidate:${candidateId}${jobId ? `:job:${jobId}` : ''}`, hashString(haystack + (job?.id || '')), JSON.stringify({ output, evidence, confidence }), nowIso())
    .run()

  return {
    engine: 'rubric-evidence-v1',
    confidence: Math.round(confidence * 100) / 100,
    limitations,
    missing_information: missingInformation,
    evidence,
    output,
    candidate: cand,
    job
  }
}

/** ATS-12 — side-by-side comparison of up to 5 candidates for one requisition. */
export const compareCandidates = async (db: D1Database, jobId: number, candidateIds: number[]) => {
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<any>()
  if (!job) throw new Error('job_not_found')
  const ids = candidateIds.slice(0, 5)
  const rows = []
  for (const id of ids) rows.push(await summarizeCandidate(db, id, jobId))

  const must = parseJson<string[]>(job.must_have_skills, [])
  const matrix = must.map((criterion) => ({
    criterion,
    cells: rows.map((r) => {
      const ev = r.evidence.find((e) => e.criterion === criterion)
      return { candidate_id: r.candidate.id, status: ev?.status || 'missing', quote: ev?.quote || null }
    })
  }))

  const ranked = [...rows]
    .sort((a, b) => (b.output.fit_score as number) - (a.output.fit_score as number))
    .map((r) => ({ candidate_id: r.candidate.id, name: `${r.candidate.first_name} ${r.candidate.last_name}`, fit_score: r.output.fit_score, confidence: r.confidence }))

  await db
    .prepare(
      `INSERT INTO ai_runs (kind, entity_ref, engine, input_hash, output, created_at)
       VALUES ('comparison', ?, 'rubric-evidence-v1', ?, ?, ?)`
    )
    .bind(`job:${jobId}`, hashString(ids.join(',') + jobId), JSON.stringify({ matrix, ranked }), nowIso())
    .run()

  return {
    job: { id: job.id, title: job.title, must_have: must },
    candidates: rows.map((r) => ({
      id: r.candidate.id,
      name: `${r.candidate.first_name} ${r.candidate.last_name}`,
      headline: r.candidate.headline,
      fit_score: r.output.fit_score,
      confidence: r.confidence,
      strengths: r.output.strengths,
      gaps: r.output.gaps,
      summary: r.output.summary,
      evidence: r.evidence,
      limitations: r.limitations
    })),
    matrix,
    ranked,
    note: 'Advisory only — no candidate is automatically rejected or advanced by this comparison.'
  }
}

/** ATS-14 — summarise submitted interviewer feedback, preserving each source row. */
export const summarizeFeedback = async (db: D1Database, applicationId: number) => {
  const { results: rows } = await db
    .prepare(
      `SELECT f.*, u.name AS interviewer_name, i.title AS interview_title, i.round
         FROM feedback f
         JOIN interviews i ON i.id = f.interview_id
         JOIN users u ON u.id = f.interviewer_id
        WHERE i.application_id = ? AND f.status = 'submitted'
        ORDER BY i.round`
    )
    .bind(applicationId)
    .all<any>()

  if (!rows.length) {
    return {
      engine: 'feedback-consensus-v1',
      feedback_count: 0,
      summary: 'No submitted feedback yet.',
      conflicts: [],
      missing_evidence: [],
      sources: [],
      limitations: ['Summary requires at least one submitted scorecard.']
    }
  }

  const recWeights: Record<string, number> = { strong_yes: 2, yes: 1, mixed: 0, no: -1, strong_no: -2 }
  const positives = rows.filter((r) => ['strong_yes', 'yes'].includes(r.recommendation))
  const negatives = rows.filter((r) => ['no', 'strong_no'].includes(r.recommendation))
  const mixed = rows.filter((r) => r.recommendation === 'mixed')
  const avg = rows.reduce((s, r) => s + (r.overall || 0), 0) / rows.length
  const spread = Math.max(...rows.map((r) => r.overall || 0)) - Math.min(...rows.map((r) => r.overall || 0))

  const conflicts: string[] = []
  if (positives.length && negatives.length) {
    conflicts.push(
      `Split recommendation: ${positives.length} positive vs ${negatives.length} negative (${positives.map((p) => p.interviewer_name).join(', ')} vs ${negatives.map((n) => n.interviewer_name).join(', ')}).`
    )
  }
  if (spread >= 3) conflicts.push(`Overall scores diverge by ${spread} points across interviewers.`)

  // criterion-level disagreement
  const byCriterion = new Map<string, number[]>()
  for (const r of rows) {
    for (const s of parseJson<any[]>(r.scores_json, [])) {
      const v = Number(s.score)
      if (!Number.isFinite(v)) continue
      if (!byCriterion.has(s.criterion)) byCriterion.set(s.criterion, [])
      byCriterion.get(s.criterion)!.push(v)
    }
  }
  for (const [criterion, vals] of byCriterion) {
    if (vals.length > 1 && Math.max(...vals) - Math.min(...vals) >= 3) {
      conflicts.push(`Criterion "${criterion}" scored ${Math.min(...vals)}–${Math.max(...vals)} — reviewers disagree.`)
    }
  }

  const missingEvidence = rows
    .filter((r) => !r.evidence || r.evidence.trim().length < 40)
    .map((r) => `${r.interviewer_name} (${r.interview_title}): recommendation recorded without substantive evidence.`)

  const summary = [
    `${rows.length} interviewer${rows.length === 1 ? '' : 's'} submitted feedback.`,
    `Average overall score ${avg.toFixed(1)}/5.`,
    `${positives.length} positive, ${mixed.length} mixed, ${negatives.length} negative recommendation${negatives.length === 1 ? '' : 's'}.`,
    conflicts.length ? `Consensus is not reached — ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} flagged.` : 'No material conflicts detected across scorecards.'
  ].join(' ')

  await db
    .prepare(
      `INSERT INTO ai_runs (kind, entity_ref, engine, input_hash, output, created_at)
       VALUES ('feedback_summary', ?, 'feedback-consensus-v1', ?, ?, ?)`
    )
    .bind(`application:${applicationId}`, hashString(rows.map((r) => r.id + ':' + r.updated_at).join('|')), JSON.stringify({ summary, conflicts, missingEvidence }), nowIso())
    .run()

  return {
    engine: 'feedback-consensus-v1',
    feedback_count: rows.length,
    average_score: Math.round(avg * 10) / 10,
    score_spread: spread,
    summary,
    conflicts,
    missing_evidence: missingEvidence,
    sources: rows.map((r) => ({
      feedback_id: r.id,
      interview_id: r.interview_id,
      interview: r.interview_title,
      round: r.round,
      interviewer: r.interviewer_name,
      overall: r.overall,
      recommendation: r.recommendation,
      evidence: r.evidence,
      submitted_at: r.submitted_at
    })),
    limitations: [
      'Summary is derived from submitted scorecards and never overwrites them.',
      'Individual scores and comments remain the authoritative record.'
    ]
  }
}

/** ATS-13 — natural language query interpretation with an explainable plan. */
export const interpretQuery = (query: string) => {
  const expanded = expandQuery(query)
  const skills = expanded.slice(0, 8)
  const hints = skills.flatMap((s) => synonymHint(s).slice(0, 2)).slice(0, 6)
  return {
    engine: 'semantic-plan-v1',
    original: query,
    interpreted_terms: expanded,
    synonyms_applied: [...new Set(hints)],
    explanation:
      'Query is normalised (stop-words removed, terms stemmed) and expanded with the role synonym dictionary, ' +
      'then scored by weighted term overlap across skills, titles, employers and resume text.',
    can_refine: ['add location filter', 'require minimum experience', 'exclude current employer', 'restrict to talent pool']
  }
}

/** ATS-15 — transparent bottleneck / source quality insights (no opaque predictions). */
export const sourceInsights = (analytics: any) => {
  const insights: { severity: 'info' | 'warning' | 'critical'; title: string; detail: string; inputs: string[] }[] = []
  const m = analytics.metrics || {}

  const weakest = [...(analytics.bySource || [])].sort((a, b) => a.conversion - b.conversion)[0]
  const strongest = [...(analytics.bySource || [])].sort((a, b) => b.conversion - a.conversion)[0]
  if (strongest && strongest.applications >= 5) {
    insights.push({
      severity: 'info',
      title: `${strongest.source} is the highest-converting source`,
      detail: `${strongest.conversion}% of its ${strongest.applications} applications reached hired.`,
      inputs: [`applications(${strongest.applications})`, `hired(${strongest.hired})`, 'conversion = hired / applications']
    })
  }
  if (weakest && weakest.applications >= 5 && weakest.conversion < 5) {
    insights.push({
      severity: 'warning',
      title: `${weakest.source} converts poorly`,
      detail: `Only ${weakest.conversion}% of ${weakest.applications} applications from this source were hired.`,
      inputs: [`applications(${weakest.applications})`, `hired(${weakest.hired})`]
    })
  }

  const funnel = analytics.funnel || []
  for (let i = 1; i < funnel.length; i++) {
    const prev = funnel[i - 1].count
    const cur = funnel[i].count
    if (prev >= 5 && cur <= prev * 0.35) {
      insights.push({
        severity: cur <= prev * 0.2 ? 'critical' : 'warning',
        title: `Bottleneck at ${funnel[i - 1].stage} → ${funnel[i].stage}`,
        detail: `${prev - cur} of ${prev} candidates drop between these stages (${funnel[i].conversion_from_previous}% conversion).`,
        inputs: [`stage_in(${prev})`, `stage_in(${cur})`]
      })
    }
  }

  if ((m.requisition_aging || 0) > 45) {
    insights.push({
      severity: 'warning',
      title: 'Requisitions are aging',
      detail: `Median open requisition age is ${m.requisition_aging} days.`,
      inputs: ['jobs.opened_at', 'jobs.status in (open,paused)']
    })
  }
  const overdue = (analytics.byRecruiter || []).reduce((s: number, r: any) => s + (r.overdue || 0), 0)
  if (overdue > 0) {
    insights.push({
      severity: overdue > 10 ? 'critical' : 'warning',
      title: `${overdue} applications past SLA`,
      detail: 'These applications have exceeded their configured stage SLA and appear in the overdue queue.',
      inputs: ['applications.stage_entered_at', 'sla_settings.threshold_hours']
    })
  }

  return {
    engine: 'insight-rules-v1',
    generated_at: nowIso(),
    insights,
    disclaimer: 'Insights are rule-based over the current filtered dataset. No predictive modelling is applied.'
  }
}
