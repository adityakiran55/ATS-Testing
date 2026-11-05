/**
 * ATS-07 — recruiter SLA and stage aging.
 * All calculations are UTC-based; stage_entered_at is authoritative.
 * Settings are configurable per stage; escalations create tasks.
 */
import { nowIso, hoursBetween, parseJson, addHours } from './util'

export type SlaSetting = {
  id: number
  scope: string
  stage: string | null
  threshold_hours: number
  escalate_to: string | null
  enabled: number
}

export const DEFAULT_SLAS: { stage: string; threshold_hours: number; label: string }[] = [
  { stage: 'applied', threshold_hours: 24, label: 'First review' },
  { stage: 'parsing', threshold_hours: 6, label: 'Resume processing' },
  { stage: 'screening', threshold_hours: 48, label: 'Screening decision' },
  { stage: 'recruiter_review', threshold_hours: 72, label: 'Recruiter review' },
  { stage: 'manager_review', threshold_hours: 48, label: 'Hiring manager review' },
  { stage: 'interview', threshold_hours: 120, label: 'Interview completion' },
  { stage: 'offer', threshold_hours: 72, label: 'Offer decision' }
]

export const loadSlas = async (db: D1Database): Promise<SlaSetting[]> => {
  const { results } = await db
    .prepare("SELECT * FROM sla_settings WHERE scope = 'stage' AND enabled = 1")
    .all<SlaSetting>()
  if (results.length) return results
  return DEFAULT_SLAS.map((s, i) => ({
    id: -(i + 1),
    scope: 'stage',
    stage: s.stage,
    threshold_hours: s.threshold_hours,
    escalate_to: null,
    enabled: 1
  }))
}

export const slaMap = (slas: SlaSetting[]): Record<string, number> =>
  slas.reduce((acc, s) => {
    if (s.stage) acc[s.stage] = s.threshold_hours
    return acc
  }, {} as Record<string, number>)

export type AgingRow = {
  application_id: number
  candidate_id: number
  candidate_name: string
  job_id: number
  job_title: string
  stage: string
  status: string
  stage_entered_at: string
  hours_in_stage: number
  threshold_hours: number
  overdue: boolean
  overdue_hours: number
  recruiter_id: number | null
  recruiter_name: string | null
  first_review_at: string | null
  hours_to_first_review: number | null
}

export const loadAging = async (db: D1Database, filter: { recruiterId?: number; jobId?: number } = {}) => {
  const slas = await loadSlas(db)
  const thresholds = slaMap(slas)
  const where: string[] = ["a.status = 'active'"]
  const args: unknown[] = []
  if (filter.recruiterId) { where.push('a.recruiter_id = ?'); args.push(filter.recruiterId) }
  if (filter.jobId) { where.push('a.job_id = ?'); args.push(filter.jobId) }

  const { results } = await db
    .prepare(
      `SELECT a.id, a.candidate_id, a.job_id, a.stage, a.status, a.stage_entered_at, a.recruiter_id,
              a.first_review_at, c.first_name, c.last_name, j.title AS job_title, u.name AS recruiter_name
         FROM applications a
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
         LEFT JOIN users u ON u.id = a.recruiter_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.stage_entered_at ASC`
    )
    .bind(...args)
    .all<any>()

  const now = nowIso()
  const rows: AgingRow[] = results.map((r) => {
    const hours = hoursBetween(r.stage_entered_at, now)
    const threshold = thresholds[r.stage] ?? 48
    return {
      application_id: r.id,
      candidate_id: r.candidate_id,
      candidate_name: `${r.first_name} ${r.last_name}`,
      job_id: r.job_id,
      job_title: r.job_title,
      stage: r.stage,
      status: r.status,
      stage_entered_at: r.stage_entered_at,
      hours_in_stage: Math.round(hours * 10) / 10,
      threshold_hours: threshold,
      overdue: hours > threshold,
      overdue_hours: hours > threshold ? Math.round((hours - threshold) * 10) / 10 : 0,
      recruiter_id: r.recruiter_id,
      recruiter_name: r.recruiter_name,
      first_review_at: r.first_review_at,
      hours_to_first_review: r.first_review_at ? Math.round(hoursBetween(r.stage_entered_at, r.first_review_at) * 10) / 10 : null
    }
  })

  const overdue = rows.filter((r) => r.overdue)
  return {
    rows,
    overdue,
    summary: {
      active: rows.length,
      overdue: overdue.length,
      overdue_pct: rows.length ? Math.round((overdue.length / rows.length) * 1000) / 10 : 0,
      by_stage: rows.reduce((acc: Record<string, { active: number; overdue: number; threshold: number }>, r) => {
        acc[r.stage] = acc[r.stage] || { active: 0, overdue: 0, threshold: r.threshold_hours }
        acc[r.stage].active++
        if (r.overdue) acc[r.stage].overdue++
        return acc
      }, {})
    }
  }
}

/** Workload per recruiter: open applications, overdue count, requisitions owned. */
export const loadWorkload = async (db: D1Database) => {
  const aging = await loadAging(db)
  const { results: recruiters } = await db
    .prepare("SELECT id, name, email FROM users WHERE role IN ('recruiter','admin','coordinator') AND active = 1")
    .all<any>()
  const { results: jobs } = await db
    .prepare("SELECT recruiter_id, COUNT(*) AS n FROM jobs WHERE status IN ('open','paused') GROUP BY recruiter_id")
    .all<any>()
  const jobCount = new Map<number, number>(jobs.map((j: any) => [j.recruiter_id, Number(j.n)]))

  return recruiters.map((r) => {
    const mine = aging.rows.filter((a) => a.recruiter_id === r.id)
    return {
      recruiter_id: r.id,
      name: r.name,
      email: r.email,
      active_applications: mine.length,
      overdue: mine.filter((a) => a.overdue).length,
      avg_hours_in_stage: mine.length
        ? Math.round((mine.reduce((s, a) => s + a.hours_in_stage, 0) / mine.length) * 10) / 10
        : 0,
      open_requisitions: jobCount.get(r.id) || 0,
      load_score: mine.length + (jobCount.get(r.id) || 0) * 2 + mine.filter((a) => a.overdue).length * 3
    }
  }).sort((a, b) => b.load_score - a.load_score)
}

/** Requisition aging: days open, applications, fill progress. */
export const loadRequisitionAging = async (db: D1Database) => {
  const { results } = await db
    .prepare(
      `SELECT j.*, u.name AS recruiter_name, hm.name AS manager_name,
              (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS applications,
              (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'hired') AS hires
         FROM jobs j
         LEFT JOIN users u ON u.id = j.recruiter_id
         LEFT JOIN users hm ON hm.id = j.hiring_manager_id
        WHERE j.status IN ('open','paused','approved','filled')
        ORDER BY j.opened_at ASC`
    )
    .all<any>()

  const now = nowIso()
  return results.map((j) => {
    const days = j.opened_at ? Math.max(0, hoursBetween(j.opened_at, now) / 24) : 0
    const target = j.target_fill_date ? hoursBetween(now, j.target_fill_date) / 24 : null
    return {
      ...j,
      days_open: Math.round(days * 10) / 10,
      days_to_target: target === null ? null : Math.round(target * 10) / 10,
      past_target: target !== null && target < 0,
      fill_progress: j.openings ? Math.min(100, Math.round((j.hires / j.openings) * 100)) : 0
    }
  })
}

/** Creates escalation tasks for overdue applications; idempotent per app+day. */
export const escalateOverdue = async (db: D1Database, actorId?: number | null) => {
  const { overdue } = await loadAging(db)
  let created = 0
  for (const row of overdue) {
    const key = `SLA · ${row.candidate_name} · ${row.job_title} · ${row.stage} · ${row.stage_entered_at}`
    const existing = await db
      .prepare("SELECT id FROM tasks WHERE type = 'sla_alert' AND title = ? AND status = 'open'")
      .bind(key)
      .first<any>()
    if (existing) continue
    await db
      .prepare(
        `INSERT INTO tasks (type, title, detail, application_id, job_id, assignee_id, due_at, created_by)
         VALUES ('sla_alert', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        key,
        `Application exceeded the ${row.threshold_hours}h SLA for stage "${row.stage}" by ${row.overdue_hours}h.`,
        row.application_id,
        row.job_id,
        row.recruiter_id,
        addHours(nowIso(), 24),
        actorId ?? null
      )
      .run()
    created++
  }
  return { created, overdue: overdue.length }
}
