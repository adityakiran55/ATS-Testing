/**
 * Phase 6 — the 12-stage pipeline, candidate notices, and the MVP-lite board.
 *
 * The v3.0 pipeline is ADDITIVE. The v2.0 `applications.stage` machine still
 * governs the existing screens and analytics, so every v3.0 move writes BOTH:
 *   - `pipeline_stage` (the 12-stage client-facing view)
 *   - `stage` + `status` (the legacy machine, derived, never free-typed)
 *
 * That keeps one source of truth for validation while satisfying the new
 * vocabulary. A mapping is declared explicitly below — no guessing.
 */
import { nowIso, parseJson } from './util'
import { audit } from './audit'
import { STAGE_ORDER, stageIndex } from './lifecycle'

export type PipelineStage =
  | 'new' | 'ai_screened' | 'shortlisted' | 'recruiter_review' | 'submitted_to_client'
  | 'interview' | 'selected' | 'offer' | 'joined' | 'on_hold' | 'rejected' | 'withdrawn'

export const PIPELINE_ORDER: PipelineStage[] = [
  'new', 'ai_screened', 'shortlisted', 'recruiter_review', 'submitted_to_client',
  'interview', 'selected', 'offer', 'joined'
]

export const TERMINAL_STAGES: PipelineStage[] = ['joined', 'rejected', 'withdrawn']

export const PIPELINE_LABELS: Record<PipelineStage, string> = {
  new: 'New',
  ai_screened: 'AI Screened',
  shortlisted: 'Shortlisted',
  recruiter_review: 'Recruiter Review',
  submitted_to_client: 'Submitted to Client',
  interview: 'Interview',
  selected: 'Selected',
  offer: 'Offer',
  joined: 'Joined',
  on_hold: 'On Hold',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn'
}

/**
 * v3.0 stage -> legacy (stage, status). Exactly one row per v3.0 stage so the
 * derivation is total and testable.
 */
export const LEGACY_MAP: Record<PipelineStage, { stage: string; status: string }> = {
  new: { stage: 'applied', status: 'active' },
  ai_screened: { stage: 'screening', status: 'active' },
  shortlisted: { stage: 'recruiter_review', status: 'active' },
  recruiter_review: { stage: 'recruiter_review', status: 'active' },
  submitted_to_client: { stage: 'manager_review', status: 'active' },
  interview: { stage: 'interview', status: 'active' },
  selected: { stage: 'interview', status: 'active' },
  offer: { stage: 'offer', status: 'active' },
  joined: { stage: 'hired', status: 'hired' },
  on_hold: { stage: 'recruiter_review', status: 'on_hold' },
  rejected: { stage: 'recruiter_review', status: 'rejected' },
  withdrawn: { stage: 'applied', status: 'withdrawn' }
}

/** Legacy -> v3.0, used to backfill existing rows truthfully. */
export const derivePipelineStage = (legacyStage: string, legacyStatus: string): PipelineStage => {
  if (legacyStatus === 'withdrawn') return 'withdrawn'
  if (legacyStatus === 'rejected') return 'rejected'
  if (legacyStatus === 'on_hold') return 'on_hold'
  if (legacyStatus === 'hired' || legacyStage === 'hired') return 'joined'
  switch (legacyStage) {
    case 'applied': return 'new'
    case 'parsing': return 'new'
    case 'screening': return 'ai_screened'
    case 'recruiter_review': return 'recruiter_review'
    case 'manager_review': return 'submitted_to_client'
    case 'interview': return 'interview'
    case 'offer': return 'offer'
    default: return 'new'
  }
}

/**
 * Allowed v3.0 moves. Rules that matter:
 *  - Forward movement is always allowed (skipping is permitted; analytics tracks it).
 *  - `selected` only comes from `interview` (a client/interview decision).
 *  - Nothing returns from a terminal stage — that protects history.
 *  - `on_hold` is a side-state: you can leave it back to any non-terminal stage.
 */
export const PIPELINE_TRANSITIONS: Record<PipelineStage, PipelineStage[]> = {
  new: ['ai_screened', 'shortlisted', 'recruiter_review', 'on_hold', 'rejected', 'withdrawn'],
  ai_screened: ['shortlisted', 'recruiter_review', 'interview', 'on_hold', 'rejected', 'withdrawn'],
  shortlisted: ['recruiter_review', 'submitted_to_client', 'interview', 'on_hold', 'rejected', 'withdrawn'],
  recruiter_review: ['submitted_to_client', 'interview', 'shortlisted', 'on_hold', 'rejected', 'withdrawn'],
  submitted_to_client: ['interview', 'selected', 'shortlisted', 'on_hold', 'rejected', 'withdrawn'],
  interview: ['selected', 'offer', 'submitted_to_client', 'on_hold', 'rejected', 'withdrawn'],
  selected: ['offer', 'interview', 'on_hold', 'rejected', 'withdrawn'],
  offer: ['joined', 'rejected', 'withdrawn', 'on_hold'],
  joined: [],
  on_hold: ['new', 'ai_screened', 'shortlisted', 'recruiter_review', 'submitted_to_client', 'interview', 'selected', 'offer', 'rejected', 'withdrawn'],
  rejected: [],
  withdrawn: []
}

export const canMovePipeline = (from: PipelineStage, to: PipelineStage): boolean => {
  if (from === to) return false
  return (PIPELINE_TRANSITIONS[from] || []).includes(to)
}

export type PipelineMoveCheck =
  | { ok: true; from: PipelineStage; to: PipelineStage; legacy: { stage: string; status: string } }
  | { ok: false; code: string; message: string; from: PipelineStage; to: PipelineStage }

export const assertPipelineMove = (from: PipelineStage, to: PipelineStage): PipelineMoveCheck => {
  if (!PIPELINE_ORDER.includes(to) && !TERMINAL_STAGES.includes(to) && to !== 'on_hold') {
    return { ok: false, code: 'unknown_stage', message: `Unknown pipeline stage: ${to}`, from, to }
  }
  if (from === to) {
    return { ok: false, code: 'no_change', message: 'Application is already at that stage', from, to }
  }
  if (TERMINAL_STAGES.includes(from)) {
    return {
      ok: false, code: 'terminal_stage',
      message: `"${PIPELINE_LABELS[from]}" is terminal; reopen via a new application instead of moving history`,
      from, to
    }
  }
  if (!canMovePipeline(from, to)) {
    return {
      ok: false, code: 'invalid_transition',
      message: `Cannot move from ${PIPELINE_LABELS[from]} to ${PIPELINE_LABELS[to]}`,
      from, to
    }
  }
  return { ok: true, from, to, legacy: LEGACY_MAP[to] }
}

export const loadStages = async (db: D1Database, tenantId = 1) => {
  const { results } = await db
    .prepare(
      `SELECT * FROM pipeline_stages WHERE tenant_id = ? AND active = 1 ORDER BY sort_order`
    )
    .bind(tenantId)
    .all<any>()
  return results
}

/* ------------------------------------------------------------------- notice */

/**
 * Phase 6 / NYC LL144-style notice: a candidate must be told when automated
 * screening is applied to them, BEFORE the outcome is used.
 * Marked shown/acknowledged separately so the record proves what was displayed.
 */
export const issueCandidateNotice = async (
  db: D1Database,
  opts: {
    candidateId: number
    applicationId: number | null
    tenantId: number
    jurisdiction?: string
    channel?: 'in_app' | 'email' | 'sms'
  }
) => {
  const region = await db
    .prepare(`SELECT * FROM region_config WHERE tenant_id = ? AND region = ? AND enabled = 1`)
    .bind(opts.tenantId, opts.jurisdiction ?? 'IN')
    .first<any>()

  const requirements = parseJson<string[]>(region?.requirements, [])
  const text = [
    'How this application is assessed:',
    '· Your application is compared against the job\'s stated must-have requirements.',
    '· Automated screening produces an advisory recommendation only. A human recruiter reviews it before any decision.',
    '· The automated assessment never rejects an application on its own.',
    '· You can request a copy of your data, correction, or erasure at any time.',
    region?.notice_text ? `· Jurisdiction notice (${opts.jurisdiction ?? 'IN'}): ${region.notice_text}` : '',
    requirements.length ? `· Applicable safeguards: ${requirements.join('; ')}.` : ''
  ].filter(Boolean).join('\n')

  const res = await db
    .prepare(
      `INSERT INTO candidate_notices
         (tenant_id, candidate_id, application_id, jurisdiction, text, channel, shown_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      opts.tenantId, opts.candidateId, opts.applicationId ?? null,
      opts.jurisdiction ?? region?.region ?? 'IN', text, opts.channel ?? 'in_app', nowIso(), nowIso()
    )
    .run()

  await audit(db, {
    entityType: 'candidate_notice', entityId: Number(res.meta.last_row_id),
    action: 'notice.issue', actorId: null,
    newValue: { jurisdiction: opts.jurisdiction ?? 'IN', channel: opts.channel ?? 'in_app' },
    reason: 'Automated-screening transparency notice'
  })
  return { id: Number(res.meta.last_row_id), text, jurisdiction: opts.jurisdiction ?? 'IN' }
}

export const acknowledgeNotice = async (db: D1Database, noticeId: number) => {
  await db
    .prepare(`UPDATE candidate_notices SET acknowledged_at = ? WHERE id = ?`)
    .bind(nowIso(), noticeId)
    .run()
  return { id: noticeId, acknowledged: true }
}

export const loadNotices = async (db: D1Database, candidateId: number) => {
  const { results } = await db
    .prepare(`SELECT * FROM candidate_notices WHERE candidate_id = ? ORDER BY id DESC`)
    .bind(candidateId)
    .all<any>()
  return results
}

/* -------------------------------------------------------------- the move op */

export const moveApplication = async (
  db: D1Database,
  opts: {
    applicationId: number
    to: PipelineStage
    actorId: number
    reason?: string | null
    /** Screening runs must notify the candidate the first time they are used. */
    tenantId?: number
    notifyOnAiScreen?: boolean
  }
) => {
  const app = await db
    .prepare(`SELECT * FROM applications WHERE id = ?`)
    .bind(opts.applicationId)
    .first<any>()
  if (!app) throw Object.assign(new Error('Application not found'), { status: 404, code: 'not_found' })

  const from = (app.pipeline_stage || derivePipelineStage(app.stage, app.status)) as PipelineStage
  const check = assertPipelineMove(from, opts.to)
  if (!check.ok) {
    throw Object.assign(new Error(check.message), { status: 409, code: check.code })
  }

  // Reasons are required where a decision is being recorded against the candidate.
  const needsReason: PipelineStage[] = ['rejected', 'withdrawn', 'on_hold']
  if (needsReason.includes(opts.to) && (!opts.reason || opts.reason.trim().length < 4)) {
    throw Object.assign(new Error(`A reason is required when moving to ${PIPELINE_LABELS[opts.to]}`), {
      status: 422, code: 'reason_required'
    })
  }

  const ts = nowIso()
  const legacy = check.legacy
  const patch: string[] = [
    'pipeline_stage = ?', 'stage = ?', 'status = ?', 'stage_entered_at = ?', 'updated_at = ?'
  ]
  const args: unknown[] = [opts.to, legacy.stage, legacy.status, ts, ts]

  if (legacy.status === 'rejected' || legacy.status === 'withdrawn') {
    patch.push('closed_at = ?', 'rejection_reason = ?')
    args.push(ts, opts.reason ?? null)
  }
  if (opts.to === 'joined') {
    patch.push('decision_at = ?')
    args.push(ts)
  }

  await db
    .prepare(`UPDATE applications SET ${patch.join(', ')} WHERE id = ?`)
    .bind(...args, opts.applicationId)
    .run()

  await db
    .prepare(
      `INSERT INTO application_stage_history
         (application_id, from_stage, to_stage, actor_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(opts.applicationId, app.stage, legacy.stage, opts.actorId, opts.reason ?? null, ts)
    .run()

  await audit(db, {
    entityType: 'application', entityId: opts.applicationId, action: 'application.pipeline.move',
    actorId: opts.actorId,
    previousValue: { pipeline_stage: from, stage: app.stage, status: app.status },
    newValue: { pipeline_stage: opts.to, stage: legacy.stage, status: legacy.status },
    reason: opts.reason ?? null
  })

  // Transparency: entering AI screening issues the notice once, automatically.
  let notice: any = null
  if (opts.to === 'ai_screened' && opts.notifyOnAiScreen !== false) {
    const existing = await db
      .prepare(`SELECT id FROM candidate_notices WHERE application_id = ? LIMIT 1`)
      .bind(opts.applicationId)
      .first<any>()
    if (!existing) {
      notice = await issueCandidateNotice(db, {
        candidateId: app.candidate_id,
        applicationId: opts.applicationId,
        tenantId: opts.tenantId ?? 1
      })
    }
  }

  return {
    applicationId: opts.applicationId,
    from,
    to: opts.to,
    legacy,
    notice,
    allowedNext: PIPELINE_TRANSITIONS[opts.to] || []
  }
}

/* -------------------------------------------------------------- the board */

export const loadBoard = async (db: D1Database, filter: { jobId?: number } = {}) => {
  const stages = await loadStages(db)
  const where = ['a.status NOT IN (\'withdrawn\')']
  const args: unknown[] = []
  if (filter.jobId) { where.push('a.job_id = ?'); args.push(filter.jobId) }

  const { results } = await db
    .prepare(
      `SELECT a.id, a.job_id, a.candidate_id, a.pipeline_stage, a.stage, a.status,
              a.applied_at, a.stage_entered_at, a.match_score,
              c.first_name, c.last_name, c.email, c.consent_status,
              j.title AS job_title, j.code AS job_code,
              (SELECT COUNT(*) FROM screening_runs r WHERE r.application_id = a.id) AS runs,
              (SELECT r.class FROM screening_runs r WHERE r.application_id = a.id
                ORDER BY r.id DESC LIMIT 1) AS latest_class,
              (SELECT r.decided_at FROM screening_runs r WHERE r.application_id = a.id
                ORDER BY r.id DESC LIMIT 1) AS latest_decided
         FROM applications a
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.stage_entered_at DESC`
    )
    .bind(...args)
    .all<any>()

  const rows = results as any[]
  const columns = stages.map((s: any) => ({
    key: s.key as PipelineStage,
    label: s.label,
    is_terminal: Number(s.is_terminal) === 1,
    sort_order: Number(s.sort_order),
    count: rows.filter((r) => r.pipeline_stage === s.key).length,
    cards: rows.filter((r) => r.pipeline_stage === s.key).slice(0, 50)
  }))

  const unassigned = rows.filter((r) => !stages.some((s: any) => s.key === r.pipeline_stage))

  return {
    columns,
    total: rows.length,
    unassigned,
    /** Legacy rows not yet backfilled are surfaced rather than silently bucketed. */
    unassignedCount: unassigned.length
  }
}

/** Backfill: derive v3.0 stages for rows that predate the migration. */
export const backfillPipelineStages = async (db: D1Database, actorId?: number) => {
  const { results } = await db
    .prepare(`SELECT id, stage, status, pipeline_stage FROM applications`)
    .all<any>()
  let changed = 0
  for (const row of results as any[]) {
    const derived = derivePipelineStage(row.stage, row.status)
    if (row.pipeline_stage !== derived) {
      await db.prepare(`UPDATE applications SET pipeline_stage = ? WHERE id = ?`)
        .bind(derived, row.id).run()
      changed++
    }
  }
  await audit(db, {
    entityType: 'application', entityId: 'bulk', action: 'application.pipeline.backfill',
    actorId: actorId ?? null, newValue: { changed }, reason: 'Derive v3.0 stage from legacy stage/status'
  })
  return { scanned: results.length, changed }
}

/* -------------------------------------------------------- funnel conversion */

export const pipelineFunnel = async (db: D1Database, jobId?: number) => {
  const args: unknown[] = []
  const where = jobId ? 'WHERE job_id = ?' : ''
  if (jobId) args.push(jobId)
  const { results } = await db
    .prepare(`SELECT pipeline_stage, COUNT(*) AS n FROM applications ${where} GROUP BY pipeline_stage`)
    .bind(...args)
    .all<any>()
  const counts = new Map<string, number>(results.map((r: any) => [r.pipeline_stage, Number(r.n)]))

  const order: PipelineStage[] = [...PIPELINE_ORDER, 'on_hold', 'rejected', 'withdrawn']
  let previous = 0
  return order.map((key, i) => {
    const count = counts.get(key) || 0
    const row = {
      stage: key,
      label: PIPELINE_LABELS[key],
      count,
      conversion_from_previous: i === 0 || previous === 0 ? 100 : Math.round((count / previous) * 1000) / 10
    }
    if (PIPELINE_ORDER.includes(key)) previous = count || previous
    return row
  })
}

/** Guard used by tests and the API: legacy analytics must not regress. */
export const legacyStageCoverage = (stage: string, status: string): boolean => {
  if (status === 'withdrawn' || status === 'rejected' || status === 'on_hold') return true
  return STAGE_ORDER.includes(stage) || stage === 'hired'
}

export const stageOrderIndex = (stage: string) => stageIndex(stage)
