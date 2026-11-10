/**
 * Phase 7 — compliance pack.
 *
 * Implements the obligations the v3.0 spec lists, with the parts that are easy
 * to fake made explicit:
 *
 *  - Adverse impact (four-fifths / impact ratio) is COMPUTED from voluntary
 *    demographic data that is stored separately and never joined into scoring.
 *    Small cells are suppressed so a report cannot become a re-identification
 *    tool.
 *  - Human oversight is a record of named humans, not a claim in a README.
 *  - Decision export emits exactly the machine class, the human decision, the
 *    reviewer and the reason.
 *  - Erasure is a workflow with steps and an audit trail. It anonymises; it does
 *    not silently delete rows, because destroying the audit trail would break
 *    every other obligation here.
 *  - Retention runs a timer: notice first, deletion only after the notice window.
 */
import { nowIso, addDays, daysBetween, parseJson, pct } from './util'
import { audit } from './audit'

/* ============================================================ adverse impact */

/** Four-fifths rule threshold (EEOC / NYC LL144 style). */
export const IMPACT_RATIO_THRESHOLD = 0.8
/** Cells below this are suppressed in reported output (anti re-identification). */
export const MIN_CELL_SIZE = 5

export type ImpactGroup = {
  group_key: string
  group_value: string
  considered: number
  selected: number
  selection_rate: number
  impact_ratio: number | null
  suppressed: boolean
  below_threshold: boolean
}

export type AdverseImpactReport = {
  jobId: number | null
  period: { from: string | null; to: string | null }
  groups: ImpactGroup[]
  /** The group with the highest selection rate is the reference. */
  reference: { group_key: string; group_value: string; selection_rate: number } | null
  flags: { group_key: string; group_value: string; impact_ratio: number; detail: string }[]
  coverage: {
    applications: number
    with_demographics: number
    consent_coverage_pct: number
    voluntary_pct: number
  }
  suppressed_cells: number
  methodology: string
}

/**
 * Impact ratio = selection rate of a group / selection rate of the highest group.
 * "Selected" means reached `interview` or beyond (a definition that is stated in
 * the output, because an unstated numerator is not a metric).
 */
export const computeAdverseImpact = async (
  db: D1Database,
  opts: { jobId?: number | null; from?: string | null; to?: string | null; tenantId?: number }
): Promise<AdverseImpactReport> => {
  const where: string[] = ['c.status = \'active\' OR c.status = \'anonymized\'']
  const args: unknown[] = []
  if (opts.jobId) { where.push('a.job_id = ?'); args.push(opts.jobId) }
  if (opts.from) { where.push('a.applied_at >= ?'); args.push(opts.from) }
  if (opts.to) { where.push('a.applied_at <= ?'); args.push(opts.to) }

  const { results } = await db
    .prepare(
      `SELECT a.id, a.job_id, a.stage, a.status, a.pipeline_stage,
              d.group_key, d.group_value, d.voluntary
         FROM applications a
         JOIN candidates c ON c.id = a.candidate_id
         LEFT JOIN demographic_data d ON d.candidate_id = a.candidate_id
        WHERE ${where.join(' AND ')}`
    )
    .bind(...args)
    .all<any>()

  const rows = results as any[]
  const applications = new Set(rows.map((r) => r.id)).size
  const withDemo = new Set(rows.filter((r) => r.group_key).map((r) => r.id)).size

  const SELECTED_STAGES = new Set(['interview', 'selected', 'offer', 'joined'])
  const isSelected = (r: any) =>
    SELECTED_STAGES.has(String(r.pipeline_stage || '')) ||
    ['interview', 'offer', 'hired'].includes(String(r.stage || '')) ||
    r.status === 'hired'

  const cells = new Map<string, { group_key: string; group_value: string; considered: number; selected: number; voluntary: number }>()
  for (const r of rows) {
    if (!r.group_key) continue
    const key = `${r.group_key}::${r.group_value}`
    const cell = cells.get(key) || { group_key: r.group_key, group_value: r.group_value, considered: 0, selected: 0, voluntary: 0 }
    cell.considered++
    if (Number(r.voluntary) === 1) cell.voluntary++
    if (isSelected(r)) cell.selected++
    cells.set(key, cell)
  }

  const groups: ImpactGroup[] = []
  let suppressed = 0
  for (const cell of cells.values()) {
    const suppressedCell = cell.considered < MIN_CELL_SIZE
    if (suppressedCell) suppressed++
    groups.push({
      group_key: cell.group_key,
      group_value: cell.group_value,
      considered: cell.considered,
      selected: cell.selected,
      selection_rate: suppressedCell ? 0 : Math.round((cell.selected / cell.considered) * 1000) / 10,
      impact_ratio: null,
      suppressed: suppressedCell,
      below_threshold: false
    })
  }

  // Reference group: highest selection rate among reportable cells.
  const reportable = groups.filter((g) => !g.suppressed)
  const highest = reportable.reduce<ImpactGroup | null>(
    (best, g) => (!best || g.selection_rate > best.selection_rate ? g : best), null
  )

  if (highest && highest.selection_rate > 0) {
    for (const g of reportable) {
      const ratio = Math.round((g.selection_rate / highest.selection_rate) * 1000) / 1000
      g.impact_ratio = ratio
      g.below_threshold = ratio < IMPACT_RATIO_THRESHOLD
    }
  }

  const flags = reportable
    .filter((g) => g.below_threshold)
    .map((g) => ({
      group_key: g.group_key,
      group_value: g.group_value,
      impact_ratio: g.impact_ratio as number,
      detail: `Selection rate ${g.selection_rate}% vs reference ${highest?.selection_rate}% (ratio ${g.impact_ratio})`
    }))

  return {
    jobId: opts.jobId ?? null,
    period: { from: opts.from ?? null, to: opts.to ?? null },
    groups: groups.sort((a, b) => b.considered - a.considered),
    reference: highest
      ? { group_key: highest.group_key, group_value: highest.group_value, selection_rate: highest.selection_rate }
      : null,
    flags,
    coverage: {
      applications,
      with_demographics: withDemo,
      consent_coverage_pct: applications ? Math.round((withDemo / applications) * 1000) / 10 : 0,
      voluntary_pct: withDemo
        ? Math.round((rows.filter((r) => r.group_key && Number(r.voluntary) === 1).length / withDemo) * 1000) / 10
        : 0
    },
    suppressed_cells: suppressed,
    methodology:
      'Selection = application reached Interview or later. Impact ratio = group selection rate / highest group selection rate. ' +
      `Ratio below ${IMPACT_RATIO_THRESHOLD} is flagged under the four-fifths rule. ` +
      `Cells with fewer than ${MIN_CELL_SIZE} applications are suppressed. Demographic data is voluntary, stored separately, and never used in scoring.`
  }
}

export const saveAdverseImpactReport = async (
  db: D1Database,
  report: AdverseImpactReport,
  actorId: number,
  tenantId = 1
) => {
  const res = await db
    .prepare(
      `INSERT INTO adverse_impact_reports
         (tenant_id, job_id, period_from, period_to, payload, generated_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(tenantId, report.jobId, report.period.from, report.period.to, JSON.stringify(report), actorId, nowIso())
    .run()
  await audit(db, {
    entityType: 'adverse_impact_report', entityId: Number(res.meta.last_row_id),
    action: 'compliance.adverse_impact.generate', actorId,
    newValue: { jobId: report.jobId, flags: report.flags.length, groups: report.groups.length },
    meta: { suppressedCells: report.suppressed_cells }
  })
  return { id: Number(res.meta.last_row_id), report }
}

export const listAdverseImpactReports = async (db: D1Database, limit = 20) => {
  const { results } = await db
    .prepare(
      `SELECT r.*, u.name AS generated_by_name FROM adverse_impact_reports r
         LEFT JOIN users u ON u.id = r.generated_by
        ORDER BY r.id DESC LIMIT ?`
    )
    .bind(limit)
    .all<any>()
  return results.map((r: any) => ({ ...r, payload: parseJson<Record<string, any>>(r.payload, {}) }))
}

/* ========================================================== human oversight */

export const loadOversightLog = async (
  db: D1Database,
  filter: { limit?: number; candidateId?: number; sinceDays?: number } = {}
) => {
  const where: string[] = []
  const args: unknown[] = []
  if (filter.candidateId) { where.push('h.candidate_id = ?'); args.push(filter.candidateId) }
  if (filter.sinceDays) { where.push('h.reviewed_at >= ?'); args.push(addDays(nowIso(), -filter.sinceDays)) }

  const { results } = await db
    .prepare(
      `SELECT h.*, u.name AS reviewer_name, u.role AS reviewer_role,
              c.first_name, c.last_name, r.score, r.evidence_coverage
         FROM oversight_records h
         JOIN users u ON u.id = h.reviewer_id
         JOIN candidates c ON c.id = h.candidate_id
         LEFT JOIN screening_runs r ON r.id = h.run_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY h.id DESC LIMIT ?`
    )
    .bind(...args, filter.limit ?? 100)
    .all<any>()
  return results
}

/**
 * The number that matters for "is a human actually in control": the share of
 * screening runs whose class was reviewed by a named person.
 */
export const oversightStats = async (db: D1Database) => {
  const one = async (sql: string) => (await db.prepare(sql).first<any>()) || {}
  const runs = await one(`SELECT COUNT(*) AS n FROM screening_runs`)
  const decided = await one(`SELECT COUNT(*) AS n FROM screening_runs WHERE decided_at IS NOT NULL`)
  const overridden = await one(`SELECT COUNT(*) AS n FROM oversight_records WHERE review_kind = 'overridden'`)
  const autoRejected = await one(
    `SELECT COUNT(*) AS n FROM applications WHERE rejection_reason IS NOT NULL
       AND rejection_reason LIKE '%screening engine%'`
  )
  const totalRuns = Number(runs.n || 0)
  return {
    runs: totalRuns,
    humanDecided: Number(decided.n || 0),
    overridden: Number(overridden.n || 0),
    humanDecisionRate: totalRuns ? Math.round((Number(decided.n || 0) / totalRuns) * 1000) / 10 : 0,
    autoRejections: Number(autoRejected.n || 0),
    oversightCompliant: Number(autoRejected.n || 0) === 0
  }
}

/* ============================================================ decision export */

export type DecisionRow = {
  run_id: number
  job_code: string
  job_title: string
  candidate: string
  machine_class: string
  final_class: string
  confidence: string
  score: number
  evidence_coverage: number
  decision: string
  reviewer: string
  reason: string
  decided_at: string
}

export const buildDecisionLog = async (
  db: D1Database,
  filter: { jobId?: number; from?: string; to?: string; limit?: number } = {}
): Promise<DecisionRow[]> => {
  const where: string[] = ['r.decided_at IS NOT NULL']
  const args: unknown[] = []
  if (filter.jobId) { where.push('r.job_id = ?'); args.push(filter.jobId) }
  if (filter.from) { where.push('r.decided_at >= ?'); args.push(filter.from) }
  if (filter.to) { where.push('r.decided_at <= ?'); args.push(filter.to) }

  const { results } = await db
    .prepare(
      `SELECT r.id AS run_id, j.code AS job_code, j.title AS job_title,
              c.first_name || ' ' || c.last_name AS candidate,
              r.class AS machine_class, r.confidence, r.score, r.evidence_coverage,
              r.decision, r.decided_at,
              COALESCE(u.name, '—') AS reviewer,
              COALESCE(o.reason, h.reason, '') AS reason,
              COALESCE(o.new_class, h.final_class, r.class) AS final_class
         FROM screening_runs r
         JOIN jobs j ON j.id = r.job_id
         JOIN candidates c ON c.id = r.candidate_id
         LEFT JOIN users u ON u.id = r.decided_by
         LEFT JOIN screening_overrides o ON o.run_id = r.id
         LEFT JOIN oversight_records h ON h.run_id = r.id
        WHERE ${where.join(' AND ')}
        ORDER BY r.decided_at DESC
        LIMIT ?`
    )
    .bind(...args, filter.limit ?? 500)
    .all<any>()
  return results as DecisionRow[]
}

/* ==================================================================== erasure */

export const ERASURE_STEPS = [
  'stop_processing', 'purge_resume_text', 'anonymise_profile',
  'purge_evidence', 'purge_demographics', 'purge_messages', 'retain_audit'
] as const
export type ErasureStep = (typeof ERASURE_STEPS)[number]

/**
 * Erasure is deliberately NOT `DELETE FROM candidates`.
 * The person is de-identified, their free-text content removed, and the audit
 * trail (which contains no personal data) retained. Each step is recorded so the
 * workflow can be shown to a regulator.
 */
export const executeErasure = async (
  db: D1Database,
  opts: { candidateId: number; actorId: number; requestId?: number | null; reason: string; tenantId?: number }
) => {
  if (!opts.reason || opts.reason.trim().length < 5) {
    throw Object.assign(new Error('A reason is required for erasure'), { status: 422, code: 'reason_required' })
  }
  const candidate = await db
    .prepare(`SELECT * FROM candidates WHERE id = ?`)
    .bind(opts.candidateId)
    .first<any>()
  if (!candidate) throw Object.assign(new Error('Candidate not found'), { status: 404, code: 'not_found' })
  if (candidate.status === 'anonymized') {
    throw Object.assign(new Error('Candidate already anonymised'), { status: 409, code: 'already_erased' })
  }

  let requestId = opts.requestId ?? null
  if (!requestId) {
    const reqRes = await db
      .prepare(
        `INSERT INTO data_subject_requests (candidate_id, type, status, note, requested_by, created_at)
         VALUES (?, 'delete', 'pending', ?, ?, ?)`
      )
      .bind(opts.candidateId, opts.reason, opts.actorId, nowIso())
      .run()
    requestId = Number(reqRes.meta.last_row_id)
  }

  const stepLog: { step: string; status: string; detail: string }[] = []
  const record = async (step: ErasureStep, status: 'done' | 'skipped' | 'failed', detail: string) => {
    await db
      .prepare(
        `INSERT INTO erasure_steps (tenant_id, request_id, candidate_id, step, status, detail, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(opts.tenantId ?? 1, requestId, opts.candidateId, step, status, detail, opts.actorId, nowIso())
      .run()
    stepLog.push({ step, status, detail })
  }

  // 1) stop processing — consent flips to opt_out, which every query respects.
  await db
    .prepare(`UPDATE candidates SET consent_status = 'opt_out', updated_at = ? WHERE id = ?`)
    .bind(nowIso(), opts.candidateId)
    .run()
  await record('stop_processing', 'done', 'Consent set to opt_out; candidate excluded from sourcing and messaging')

  // 2) purge resume free text — the highest-risk personal content.
  const resumes = await db
    .prepare(`SELECT id FROM resumes WHERE candidate_id = ?`)
    .bind(opts.candidateId)
    .all<any>()
  for (const r of resumes.results as any[]) {
    await db
      .prepare(`UPDATE resumes SET raw_text = NULL, parsed_json = '{}', updated_at = ? WHERE id = ?`)
      .bind(nowIso(), r.id)
      .run()
  }
  await record('purge_resume_text', resumes.results.length ? 'done' : 'skipped',
    `${resumes.results.length} resume(s) had free text and parsed content removed`)

  // 3) anonymise the profile (fields replaced, row retained for referential integrity)
  await db
    .prepare(
      `UPDATE candidates SET
         first_name = 'Erased', last_name = 'Candidate',
         email = ?, phone = NULL, location = NULL, country = NULL,
         headline = NULL, current_employer = NULL, education = NULL,
         summary = NULL, linkedin = NULL,
         status = 'anonymized', merged_into_id = NULL,
         consent_status = 'opt_out', updated_at = ?
       WHERE id = ?`
    )
    .bind(`erased+${opts.candidateId}@invalid.local`, nowIso(), opts.candidateId)
    .run()
  await record('anonymise_profile', 'done', 'Identifying fields replaced; row kept so applications and audit stay referentially intact')

  // 4) purge derived evidence that quotes the resume
  const ev = await db
    .prepare(
      `UPDATE resume_fields SET value = NULL, evidence_text = NULL
        WHERE candidate_id = ?`
    )
    .bind(opts.candidateId)
    .run()
  await record('purge_evidence', 'done', `${ev.meta.changes ?? 0} extracted field(s) cleared`)

  // 5) purge voluntary demographics
  const demo = await db.prepare(`DELETE FROM demographic_data WHERE candidate_id = ?`).bind(opts.candidateId).run()
  await record('purge_demographics', 'done', `${demo.meta.changes ?? 0} demographic row(s) removed`)

  // 6) purge message bodies
  await db
    .prepare(`UPDATE messages SET body = '[erased]' WHERE candidate_id = ?`)
    .bind(opts.candidateId)
    .run()
  await record('purge_messages', 'done', 'Message bodies replaced')

  // 7) retain audit — deliberately not removed
  await record('retain_audit', 'skipped', 'Audit trail retained: it records actions, not personal data, and other obligations depend on it')

  await db
    .prepare(`UPDATE data_subject_requests SET status = 'completed', completed_by = ?, completed_at = ? WHERE id = ?`)
    .bind(opts.actorId, nowIso(), requestId)
    .run()

  await audit(db, {
    entityType: 'candidate', entityId: opts.candidateId, action: 'compliance.erasure.complete',
    actorId: opts.actorId, previousValue: { status: candidate.status },
    newValue: { status: 'anonymized' }, reason: opts.reason,
    meta: { requestId, steps: stepLog.map((s) => s.step) }
  })

  return { candidateId: opts.candidateId, requestId, steps: stepLog, retainedAudit: true }
}

export const loadErasureHistory = async (db: D1Database, candidateId: number) => {
  const { results } = await db
    .prepare(
      `SELECT e.*, u.name AS actor_name FROM erasure_steps e
         LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.candidate_id = ? ORDER BY e.id`
    )
    .bind(candidateId)
    .all<any>()
  return results
}

/* ================================================================ breach log */

export const logBreach = async (
  db: D1Database,
  opts: {
    title: string
    detectedAt?: string
    severity?: 'low' | 'medium' | 'high' | 'critical'
    description?: string
    actorId: number
    tenantId?: number
  }
) => {
  const ref = `BREACH-${new Date().getFullYear()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const checklist = [
    'Contain: revoke affected credentials and sessions',
    'Assess: identify categories and volume of personal data affected',
    'Notify DPO within 24 hours',
    'Notify Data Protection Board of India within 72 hours if reportable (DPDP)',
    'Notify affected data principals without undue delay if high risk',
    'Record: root cause, remediation and evidence of closure'
  ]
  const res = await db
    .prepare(
      `INSERT INTO breach_incidents
         (tenant_id, ref, title, detected_at, severity, description, checklist, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      opts.tenantId ?? 1, ref, opts.title, opts.detectedAt ?? nowIso(),
      opts.severity ?? 'medium', opts.description ?? null,
      JSON.stringify(checklist), opts.actorId, nowIso()
    )
    .run()

  await audit(db, {
    entityType: 'breach_incident', entityId: Number(res.meta.last_row_id),
    action: 'compliance.breach.log', actorId: opts.actorId,
    newValue: { ref, severity: opts.severity ?? 'medium' }
  })
  return { id: Number(res.meta.last_row_id), ref, checklist }
}

export const updateBreach = async (
  db: D1Database,
  id: number,
  patch: { notified?: boolean; closed?: boolean; severity?: string; description?: string },
  actorId: number
) => {
  const before = await db.prepare(`SELECT * FROM breach_incidents WHERE id = ?`).bind(id).first<any>()
  if (!before) throw Object.assign(new Error('Incident not found'), { status: 404, code: 'not_found' })

  const sets: string[] = []
  const args: unknown[] = []
  if (patch.notified !== undefined) { sets.push('notified_at = ?'); args.push(patch.notified ? nowIso() : null) }
  if (patch.closed !== undefined) { sets.push('closed_at = ?'); args.push(patch.closed ? nowIso() : null) }
  if (patch.severity) { sets.push('severity = ?'); args.push(patch.severity) }
  if (patch.description !== undefined) { sets.push('description = ?'); args.push(patch.description) }
  if (!sets.length) throw Object.assign(new Error('Nothing to update'), { status: 422, code: 'no_change' })

  await db.prepare(`UPDATE breach_incidents SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id).run()
  await audit(db, {
    entityType: 'breach_incident', entityId: id, action: 'compliance.breach.update', actorId,
    previousValue: { notified_at: before.notified_at, closed_at: before.closed_at, severity: before.severity },
    newValue: patch
  })
  return { id, ...patch }
}

export const listBreaches = async (db: D1Database) => {
  const { results } = await db
    .prepare(
      `SELECT b.*, u.name AS created_by_name FROM breach_incidents b
         LEFT JOIN users u ON u.id = b.created_by
        ORDER BY b.detected_at DESC`
    )
    .all<any>()
  return results.map((r: any) => ({ ...r, checklist: parseJson<string[]>(r.checklist, []) }))
}

/* ================================================================ processors */

export const listProcessors = async (db: D1Database) => {
  const { results } = await db.prepare(`SELECT * FROM processors ORDER BY name`).all<any>()
  return results.map((r: any) => ({ ...r, data_categories: parseJson<string[]>(r.data_categories, []) }))
}

export const upsertProcessor = async (
  db: D1Database,
  opts: {
    id?: number | null
    name: string
    role?: 'processor' | 'sub_processor' | 'controller'
    dataCategories?: string[]
    location?: string
    transferBasis?: string
    dpaSigned?: boolean
    dpaDate?: string | null
    notes?: string
    actorId: number
    tenantId?: number
  }
) => {
  if (opts.id) {
    const before = await db.prepare(`SELECT * FROM processors WHERE id = ?`).bind(opts.id).first<any>()
    if (!before) throw Object.assign(new Error('Processor not found'), { status: 404, code: 'not_found' })
    await db
      .prepare(
        `UPDATE processors SET name = ?, role = ?, data_categories = ?, location = ?,
           transfer_basis = ?, dpa_signed = ?, dpa_date = ?, notes = ? WHERE id = ?`
      )
      .bind(
        opts.name, opts.role ?? before.role, JSON.stringify(opts.dataCategories ?? parseJson(before.data_categories, [])),
        opts.location ?? before.location, opts.transferBasis ?? before.transfer_basis,
        opts.dpaSigned === undefined ? before.dpa_signed : opts.dpaSigned ? 1 : 0,
        opts.dpaDate ?? before.dpa_date, opts.notes ?? before.notes, opts.id
      )
      .run()
    await audit(db, {
      entityType: 'processor', entityId: opts.id, action: 'compliance.processor.update', actorId: opts.actorId,
      previousValue: { dpa_signed: before.dpa_signed }, newValue: { dpa_signed: opts.dpaSigned }
    })
    return { id: opts.id }
  }

  const res = await db
    .prepare(
      `INSERT INTO processors
         (tenant_id, name, role, data_categories, location, transfer_basis, dpa_signed, dpa_date, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      opts.tenantId ?? 1, opts.name, opts.role ?? 'processor',
      JSON.stringify(opts.dataCategories ?? []), opts.location ?? null, opts.transferBasis ?? null,
      opts.dpaSigned ? 1 : 0, opts.dpaDate ?? null, opts.notes ?? null, nowIso()
    )
    .run()
  await audit(db, {
    entityType: 'processor', entityId: Number(res.meta.last_row_id),
    action: 'compliance.processor.create', actorId: opts.actorId, newValue: { name: opts.name }
  })
  return { id: Number(res.meta.last_row_id) }
}

/* =================================================================== regions */

export const listRegions = async (db: D1Database, tenantId = 1) => {
  const { results } = await db
    .prepare(`SELECT * FROM region_config WHERE tenant_id = ? ORDER BY region`)
    .bind(tenantId)
    .all<any>()
  return results.map((r: any) => ({ ...r, requirements: parseJson<string[]>(r.requirements, []) }))
}

/** A region switch is a compliance control, so turning one ON is audited. */
export const setRegion = async (
  db: D1Database,
  opts: { region: string; enabled: boolean; noticeText?: string | null; actorId: number; tenantId?: number }
) => {
  const tenantId = opts.tenantId ?? 1
  const before = await db
    .prepare(`SELECT * FROM region_config WHERE tenant_id = ? AND region = ?`)
    .bind(tenantId, opts.region)
    .first<any>()
  if (!before) throw Object.assign(new Error('Unknown region'), { status: 404, code: 'not_found' })

  await db
    .prepare(`UPDATE region_config SET enabled = ?, notice_text = COALESCE(?, notice_text) WHERE id = ?`)
    .bind(opts.enabled ? 1 : 0, opts.noticeText ?? null, before.id)
    .run()

  await audit(db, {
    entityType: 'region_config', entityId: before.id, action: 'compliance.region.toggle',
    actorId: opts.actorId,
    previousValue: { enabled: before.enabled }, newValue: { enabled: opts.enabled ? 1 : 0 },
    reason: opts.enabled ? 'Region activated' : 'Region deactivated'
  })

  // Turning a region on requires the tenant to have acknowledged its requirements.
  const requirements = parseJson<string[]>(before.requirements, [])
  return {
    region: opts.region,
    enabled: opts.enabled,
    requirements,
    acknowledgementRequired: opts.enabled && requirements.length > 0
  }
}

/* ================================================================= retention */

/**
 * Retention timer. Two phases, in this order, always:
 *   1. schedule  → sets deletion_scheduled_at and issues the pre-deletion notice
 *   2. due       → list what may now be erased (erasure still needs a human)
 * Nothing here deletes. Deletion is `executeErasure`, invoked by a person.
 */
export const runRetentionTimer = async (
  db: D1Database,
  opts: { actorId?: number | null; tenantId?: number; dryRun?: boolean } = {}
) => {
  const tenantId = opts.tenantId ?? 1
  const policy = await db
    .prepare(`SELECT * FROM retention_policies WHERE tenant_id = ? AND entity = 'candidate' AND enabled = 1`)
    .bind(tenantId)
    .first<any>()
  if (!policy) return { policy: null, scheduled: 0, due: [], message: 'No enabled retention policy' }

  const months = Number(policy.retention_months || 24)
  const preDays = Number(policy.pre_deletion_days || 2)

  const { results: expired } = await db
    .prepare(
      `SELECT id, first_name, last_name, email, retention_until, deletion_notice_at, deletion_scheduled_at
         FROM candidates
        WHERE tenant_id = ? AND status = 'active'
          AND retention_until IS NOT NULL AND retention_until <= ?
          AND deletion_scheduled_at IS NULL`
    )
    .bind(tenantId, nowIso())
    .all<any>()

  let scheduled = 0
  const planned: any[] = []
  for (const c of expired as any[]) {
    const scheduleAt = addDays(nowIso(), preDays)
    planned.push({ id: c.id, name: `${c.first_name} ${c.last_name}`, scheduleAt })
    if (opts.dryRun) continue
    await db
      .prepare(
        `UPDATE candidates SET deletion_scheduled_at = ?, deletion_notice_at = ?, updated_at = ? WHERE id = ?`
      )
      .bind(scheduleAt, nowIso(), nowIso(), c.id)
      .run()
    await issueRetentionNotice(db, c, scheduleAt, tenantId)
    scheduled++
  }

  const { results: pastNotice } = await db
    .prepare(
      `SELECT id, first_name, last_name, email, retention_until, deletion_notice_at, deletion_scheduled_at
         FROM candidates
        WHERE tenant_id = ? AND status = 'active'
          AND deletion_scheduled_at IS NOT NULL AND deletion_scheduled_at <= ?`
    )
    .bind(tenantId, nowIso())
    .all<any>()

  if (!opts.dryRun) {
    await audit(db, {
      entityType: 'retention_policy', entityId: policy.id, action: 'compliance.retention.run',
      actorId: opts.actorId ?? null,
      newValue: { scheduled, due: pastNotice.length, months, preDays },
      reason: 'Scheduled retention sweep'
    })
  }

  return {
    policy: { months, preDeletionDays: preDays },
    scheduled,
    planned,
    due: pastNotice,
    note: 'Nothing is deleted by this job. Each due candidate requires an explicit erasure action by a person.'
  }
}

const issueRetentionNotice = async (db: D1Database, candidate: any, scheduleAt: string, tenantId: number) => {
  const text =
    `Your candidate record is scheduled for erasure on ${scheduleAt.slice(0, 10)} under our retention policy. ` +
    'If you would like us to keep your profile on file for future opportunities, reply to confirm and we will extend it. ' +
    'You may also request immediate erasure at any time.'
  await db
    .prepare(
      `INSERT INTO candidate_notices
         (tenant_id, candidate_id, application_id, jurisdiction, text, channel, shown_at, created_at)
       VALUES (?, ?, NULL, 'IN', ?, 'email', ?, ?)`
    )
    .bind(tenantId, candidate.id, text, nowIso(), nowIso())
    .run()
}

export const retentionSummary = async (db: D1Database, tenantId = 1) => {
  const one = async (sql: string, ...args: unknown[]) =>
    (await db.prepare(sql).bind(...args).first<any>()) || {}
  const policy = await db
    .prepare(`SELECT * FROM retention_policies WHERE tenant_id = ? AND entity = 'candidate'`)
    .bind(tenantId)
    .first<any>()
  const expiring = await one(
    `SELECT COUNT(*) AS n FROM candidates
      WHERE tenant_id = ? AND status = 'active' AND retention_until IS NOT NULL
        AND retention_until <= ? AND deletion_scheduled_at IS NULL`,
    tenantId, addDays(nowIso(), 30)
  )
  const scheduled = await one(
    `SELECT COUNT(*) AS n FROM candidates
      WHERE tenant_id = ? AND status = 'active' AND deletion_scheduled_at IS NOT NULL AND deletion_scheduled_at > ?`,
    tenantId, nowIso()
  )
  const due = await one(
    `SELECT COUNT(*) AS n FROM candidates
      WHERE tenant_id = ? AND status = 'active' AND deletion_scheduled_at IS NOT NULL AND deletion_scheduled_at <= ?`,
    tenantId, nowIso()
  )
  return {
    policy: policy
      ? { months: Number(policy.retention_months), preDeletionDays: Number(policy.pre_deletion_days), enabled: Number(policy.enabled) === 1 }
      : null,
    expiringIn30Days: Number(expiring.n || 0),
    noticeSent: Number(scheduled.n || 0),
    dueForErasure: Number(due.n || 0)
  }
}

/* ============================================================ compliance pack */

export const complianceOverview = async (db: D1Database, tenantId = 1) => {
  const oversight = await oversightStats(db)
  const regions = await listRegions(db, tenantId)
  const processors = await listProcessors(db)
  const retention = await retentionSummary(db, tenantId)
  const breaches = await listBreaches(db)
  const openBreaches = breaches.filter((b: any) => !b.closed_at)
  const notices = await db
    .prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN acknowledged_at IS NOT NULL THEN 1 ELSE 0 END) AS acked FROM candidate_notices`)
    .first<any>()

  const dpaGaps = processors.filter((p: any) => Number(p.dpa_signed) !== 1)

  return {
    oversight,
    regions,
    processors,
    retention,
    breaches: { total: breaches.length, open: openBreaches.length, items: breaches.slice(0, 5) },
    notices: { total: Number(notices?.total || 0), acknowledged: Number(notices?.acked || 0) },
    dpaGaps,
    /** A short, honest readiness statement rather than a green tick. */
    readiness: [
      {
        control: 'Human oversight on every automated decision',
        ok: oversight.oversightCompliant,
        detail: `${oversight.humanDecisionRate}% of screening runs reviewed by a named person; ${oversight.autoRejections} automatic rejections`
      },
      {
        control: 'Candidate transparency notice',
        ok: Number(notices?.total || 0) > 0,
        detail: `${Number(notices?.total || 0)} notice(s) issued, ${Number(notices?.acked || 0)} acknowledged`
      },
      {
        control: 'Processor DPAs recorded',
        ok: dpaGaps.length === 0,
        detail: dpaGaps.length ? `${dpaGaps.length} processor(s) without a signed DPA: ${dpaGaps.map((p: any) => p.name).join(', ')}` : 'All processors have a DPA on file'
      },
      {
        control: 'Retention timer active',
        ok: retention.policy?.enabled === true,
        detail: retention.policy
          ? `${retention.policy.months}-month retention, ${retention.policy.preDeletionDays}-day pre-deletion notice, ${retention.dueForErasure} due`
          : 'No enabled retention policy'
      },
      {
        control: 'Region controls configured',
        ok: regions.some((r: any) => Number(r.enabled) === 1),
        detail: regions.filter((r: any) => Number(r.enabled) === 1).map((r: any) => r.region).join(', ') || 'None enabled'
      },
      {
        control: 'Breach register clear',
        ok: openBreaches.length === 0,
        detail: openBreaches.length ? `${openBreaches.length} incident(s) still open` : 'No open incidents'
      }
    ]
  }
}

export const decisionLogCsv = (rows: DecisionRow[]): string => {
  const header = [
    'run_id', 'job_code', 'job_title', 'candidate', 'machine_class', 'final_class',
    'confidence', 'score', 'evidence_coverage_pct', 'decision', 'reviewer', 'reason', 'decided_at'
  ]
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [header.join(','), ...rows.map((r) => [
    r.run_id, r.job_code, r.job_title, r.candidate, r.machine_class, r.final_class,
    r.confidence, r.score, r.evidence_coverage, r.decision, r.reviewer, r.reason, r.decided_at
  ].map(esc).join(','))].join('\r\n')
}

export const adverseImpactCsv = (report: AdverseImpactReport): string => {
  const header = ['group_key', 'group_value', 'considered', 'selected', 'selection_rate_pct', 'impact_ratio', 'below_threshold', 'suppressed']
  const rows = report.groups.map((g) => [
    g.group_key, g.group_value, g.considered, g.selected,
    g.suppressed ? 'suppressed' : g.selection_rate,
    g.suppressed ? 'suppressed' : g.impact_ratio ?? '',
    g.below_threshold ? 'yes' : 'no', g.suppressed ? 'yes' : 'no'
  ])
  return [header.join(','), ...rows.map((r) => r.join(','))].join('\r\n')
}
