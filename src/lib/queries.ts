import { nowIso, hoursBetween, parseJson, pct, truncate } from './util'
import { STAGE_ORDER, stageIndex } from './lifecycle'
import { loadAging, loadSlas } from './sla'
import { loadAnalytics } from './metrics'

/* ------------------------------------------------------------------ dashboard */
export const loadDashboard = async (db: D1Database, user: { id: number; role: string }) => {
  const one = async (sql: string, ...args: unknown[]) =>
    (await db.prepare(sql).bind(...args).first<any>()) || {}

  const jobStats = await one(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status IN ('open') THEN 1 ELSE 0 END) AS open_jobs,
      SUM(CASE WHEN status = 'pending_approval' THEN 1 ELSE 0 END) AS pending_approval,
      SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused
    FROM jobs`)

  const appStats = await one(`SELECT
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_applications,
      SUM(CASE WHEN stage = 'interview' AND status = 'active' THEN 1 ELSE 0 END) AS in_interview,
      COUNT(DISTINCT CASE WHEN status = 'active' THEN job_id END) AS jobs_with_apps,
      COUNT(*) AS all_apps
    FROM applications`)

  const intStats = await one(`SELECT
      SUM(CASE WHEN status IN ('scheduled','confirmed') THEN 1 ELSE 0 END) AS scheduled,
      SUM(CASE WHEN status = 'feedback_pending' THEN 1 ELSE 0 END) AS awaiting_feedback
    FROM interviews`)

  const intWeek = await one(
    `SELECT COUNT(*) AS n FROM interviews
      WHERE scheduled_at >= ? AND scheduled_at <= ?`,
    nowIso(),
    new Date(Date.now() + 7 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  )

  const offerStats = await one(`SELECT
      SUM(CASE WHEN status IN ('released','approval_pending','approved') THEN 1 ELSE 0 END) AS offers_out,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END) AS declined
    FROM offers`)

  const resumeStats = await one(`SELECT
      SUM(CASE WHEN status IN ('failed') THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter,
      SUM(CASE WHEN status IN ('uploaded','queued','parsing','malware_scan') THEN 1 ELSE 0 END) AS pending
    FROM resumes`)

  const dup = await one("SELECT COUNT(*) AS n FROM duplicate_reviews WHERE status = 'pending'")

  const aging = await loadAging(db)
  const analytics = await loadAnalytics(db, {})

  const { results: jobs } = await db
    .prepare(
      `SELECT j.id, j.code, j.title, j.location, j.status, j.openings, j.opened_at,
              (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS applications,
              (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'hired') AS hires
         FROM jobs j
        WHERE j.status IN ('open','paused','approved')
        ${user.role === 'hiring_manager' ? 'AND j.hiring_manager_id = ' + Number(user.id) : ''}
        ORDER BY j.opened_at ASC LIMIT 6`
    )
    .all<any>()

  const { results: activity } = await db
    .prepare(
      `SELECT a.*, u.name AS actor_name FROM audit_events a
         LEFT JOIN users u ON u.id = a.actor_id
        ORDER BY a.id DESC LIMIT 8`
    )
    .all<any>()

  const { results: taskRows } = await db
    .prepare(
      `SELECT * FROM tasks WHERE assignee_id = ? AND status IN ('open','overdue')
        ORDER BY COALESCE(due_at, created_at) ASC LIMIT 6`
    )
    .bind(user.id)
    .all<any>()

  const { results: offers } = await db
    .prepare(
      `SELECT o.*, c.first_name, c.last_name, j.title AS job_title
         FROM offers o
         JOIN applications a ON a.id = o.application_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
        WHERE o.status IN ('approval_pending','approved','released')
        ORDER BY o.updated_at DESC LIMIT 5`
    )
    .all<any>()

  return {
    stats: {
      total_jobs: Number(jobStats.total || 0),
      open_jobs: Number(jobStats.open_jobs || 0),
      pending_approval: Number(jobStats.pending_approval || 0),
      paused: Number(jobStats.paused || 0),
      active_applications: Number(appStats.active_applications || 0),
      in_interview: Number(appStats.in_interview || 0),
      jobs_with_apps: Number(appStats.jobs_with_apps || 0),
      interviews_scheduled: Number(intStats.scheduled || 0),
      interviews_this_week: Number(intWeek.n || 0),
      offers_out: Number(offerStats.offers_out || 0),
      offer_accept_rate: pct(Number(offerStats.accepted || 0), Number(offerStats.accepted || 0) + Number(offerStats.declined || 0)),
      overdue: aging.overdue.length,
      period_applications: analytics.metrics.applications
    },
    funnel: analytics.funnel,
    aging: aging.summary,
    jobs: jobs.map((j) => ({ ...j, days_open: j.opened_at ? Math.round(hoursBetween(j.opened_at, nowIso()) / 24) : 0 })),
    activity,
    tasks: {
      mine: taskRows,
      overdue: aging.overdue.slice(0, 6)
    },
    resumeQueue: {
      failed: Number(resumeStats.failed || 0) + Number(resumeStats.dead_letter || 0),
      dead_letter: Number(resumeStats.dead_letter || 0),
      pending: Number(resumeStats.pending || 0)
    },
    dupCount: Number(dup.n || 0),
    sources: analytics.bySource,
    offers
  }
}

/* ----------------------------------------------------------------------- jobs */
export const listJobs = async (db: D1Database, f: {
  status?: string; department?: string; q?: string; managerId?: number; recruiterId?: number
}) => {
  const where: string[] = []
  const args: unknown[] = []
  if (f.status) { where.push('j.status = ?'); args.push(f.status) }
  if (f.department) { where.push('j.department = ?'); args.push(f.department) }
  if (f.q) { where.push('(j.title LIKE ? OR j.code LIKE ? OR j.location LIKE ?)'); args.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`) }
  if (f.managerId) { where.push('j.hiring_manager_id = ?'); args.push(f.managerId) }
  if (f.recruiterId) { where.push('j.recruiter_id = ?'); args.push(f.recruiterId) }

  const { results } = await db
    .prepare(
      `SELECT j.*, u.name AS recruiter_name, hm.name AS manager_name,
              (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS applications,
              (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'active') AS active,
              (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'hired') AS hires,
              (SELECT COUNT(*) FROM job_postings p WHERE p.job_id = j.id AND p.status = 'published') AS live_postings
         FROM jobs j
         LEFT JOIN users u ON u.id = j.recruiter_id
         LEFT JOIN users hm ON hm.id = j.hiring_manager_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY CASE j.status WHEN 'open' THEN 0 WHEN 'pending_approval' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
                 j.opened_at DESC`
    )
    .bind(...args)
    .all<any>()

  const counts = await db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all<any>()
  const byStatus = counts.results.reduce((acc: any, r: any) => { acc[r.status] = Number(r.n); return acc }, {})
  const { results: depts } = await db.prepare('SELECT DISTINCT department FROM jobs ORDER BY department').all<any>()

  return {
    jobs: results.map((j) => ({
      ...j,
      days_open: j.opened_at ? Math.round(hoursBetween(j.opened_at, nowIso()) / 24) : 0
    })),
    byStatus,
    departments: depts.map((d: any) => d.department)
  }
}

export const getJob = async (db: D1Database, id: number) => {
  const job = await db
    .prepare(
      `SELECT j.*, u.name AS recruiter_name, u.email AS recruiter_email,
              hm.name AS manager_name, hm.email AS manager_email, cu.name AS creator_name
         FROM jobs j
         LEFT JOIN users u ON u.id = j.recruiter_id
         LEFT JOIN users hm ON hm.id = j.hiring_manager_id
         LEFT JOIN users cu ON cu.id = j.created_by
        WHERE j.id = ?`
    )
    .bind(id)
    .first<any>()
  if (!job) return null

  const apps = await db
    .prepare(
      `SELECT a.*, c.first_name, c.last_name, c.email, c.headline, c.location, c.experience_years,
              c.expected_salary, c.consent_status, u.name AS recruiter_name
         FROM applications a
         JOIN candidates c ON c.id = a.candidate_id
         LEFT JOIN users u ON u.id = a.recruiter_id
        WHERE a.job_id = ?
        ORDER BY a.applied_at DESC`
    )
    .bind(id)
    .all<any>()

  const stageSummary = STAGE_ORDER.map((stage) => ({
    stage,
    count: apps.results.filter((a: any) => a.stage === stage && a.status === 'active').length
  }))

  const postings = await db
    .prepare(
      `SELECT p.*, ch.name AS channel_name, ch.api_supported
         FROM job_postings p JOIN channels ch ON ch.id = p.channel_id
        WHERE p.job_id = ? ORDER BY ch.id`
    )
    .bind(id)
    .all<any>()

  const approvals = await db
    .prepare(
      `SELECT jp.*, u.name AS actor_name FROM job_approvals jp
         LEFT JOIN users u ON u.id = jp.actor_id
        WHERE jp.job_id = ? ORDER BY jp.id`
    )
    .bind(id)
    .all<any>()

  const auditRows = await db
    .prepare(
      `SELECT a.*, u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
        WHERE (a.entity_type = 'job' AND a.entity_id = ?) ORDER BY a.id DESC LIMIT 10`
    )
    .bind(String(id))
    .all<any>()

  return {
    job: {
      ...job,
      must_have: parseJson<string[]>(job.must_have_skills, []),
      nice_to_have: parseJson<string[]>(job.nice_to_have, []),
      days_open: job.opened_at ? Math.round(hoursBetween(job.opened_at, nowIso()) / 24) : 0
    },
    applications: apps.results,
    stageSummary,
    postings: postings.results,
    approvals: approvals.results,
    audit: auditRows.results,
    hires: apps.results.filter((a: any) => a.status === 'hired').length
  }
}

/* ----------------------------------------------------------------- candidates */
export const getCandidate = async (db: D1Database, id: number) => {
  const cand = await db
    .prepare(
      `SELECT c.*, ci.skills, ci.titles, ci.employers, ci.resume_text, ci.education AS idx_education
         FROM candidates c LEFT JOIN candidate_index ci ON ci.candidate_id = c.id
        WHERE c.id = ?`
    )
    .bind(id)
    .first<any>()
  if (!cand) return null

  const apps = await db
    .prepare(
      `SELECT a.*, j.title AS job_title, j.code AS job_code, j.location AS job_location,
              j.department, u.name AS recruiter_name
         FROM applications a JOIN jobs j ON j.id = a.job_id
         LEFT JOIN users u ON u.id = a.recruiter_id
        WHERE a.candidate_id = ? ORDER BY a.applied_at DESC`
    )
    .bind(id)
    .all<any>()

  const resumes = await db
    .prepare('SELECT * FROM resumes WHERE candidate_id = ? ORDER BY created_at DESC')
    .bind(id)
    .all<any>()

  const notes = await db
    .prepare(
      `SELECT n.*, u.name AS author_name FROM candidate_notes n
         LEFT JOIN users u ON u.id = n.author_id
        WHERE n.candidate_id = ? ORDER BY n.id DESC`
    )
    .bind(id)
    .all<any>()

  const messages = await db
    .prepare(
      `SELECT m.*, t.name AS template_name FROM messages m
         LEFT JOIN message_templates t ON t.id = m.template_id
        WHERE m.candidate_id = ? ORDER BY m.id DESC LIMIT 20`
    )
    .bind(id)
    .all<any>()

  const tags = await db
    .prepare('SELECT t.* FROM tags t JOIN candidate_tags ct ON ct.tag_id = t.id WHERE ct.candidate_id = ?')
    .bind(id)
    .all<any>()

  const pools = await db
    .prepare(
      `SELECT p.id, p.name, pm.re_engagement, pm.created_at, pm.notes FROM talent_pool_members pm
         JOIN talent_pools p ON p.id = pm.pool_id WHERE pm.candidate_id = ?`
    )
    .bind(id)
    .all<any>()

  const consents = await db
    .prepare('SELECT * FROM candidate_consent WHERE candidate_id = ?')
    .bind(id)
    .all<any>()

  const history = await db
    .prepare(
      `SELECT h.*, j.title AS job_title, u.name AS actor_name
         FROM application_stage_history h
         JOIN applications a ON a.id = h.application_id
         JOIN jobs j ON j.id = a.job_id
         LEFT JOIN users u ON u.id = h.actor_id
        WHERE a.candidate_id = ? ORDER BY h.id DESC LIMIT 40`
    )
    .bind(id)
    .all<any>()

  const interviews = await db
    .prepare(
      `SELECT i.*, j.title AS job_title, a.id AS application_id
         FROM interviews i JOIN applications a ON a.id = i.application_id
         JOIN jobs j ON j.id = a.job_id
        WHERE a.candidate_id = ? ORDER BY i.scheduled_at DESC`
    )
    .bind(id)
    .all<any>()

  const { results: allTags } = await db.prepare('SELECT * FROM tags ORDER BY name').all<any>()
  const { results: allPools } = await db.prepare('SELECT id, name FROM talent_pools ORDER BY name').all<any>()

  const mergedFrom = await db
    .prepare("SELECT id, first_name, last_name FROM candidates WHERE merged_into_id = ?")
    .bind(id)
    .all<any>()

  return {
    candidate: {
      ...cand,
      skills: (cand.skills || '').split(',').map((s: string) => s.trim()).filter(Boolean),
      titles: (cand.titles || '').split(',').map((s: string) => s.trim()).filter(Boolean),
      employers: (cand.employers || '').split(',').map((s: string) => s.trim()).filter(Boolean),
      education_list: (cand.idx_education || cand.education || '').split(',').map((s: string) => s.trim()).filter(Boolean)
    },
    applications: apps.results,
    resumes: resumes.results,
    notes: notes.results,
    messages: messages.results,
    tags: tags.results,
    pools: pools.results,
    consents: consents.results,
    history: history.results,
    interviews: interviews.results,
    allTags: allTags,
    allPools: allPools,
    mergedFrom: mergedFrom.results
  }
}

/* ---------------------------------------------------------------- interviews */
export const listInterviews = async (db: D1Database, user: { id: number; role: string }, filter: { status?: string } = {}) => {
  const scoped = user.role === 'interviewer'
  const where: string[] = []
  const args: unknown[] = []
  if (filter.status) { where.push('i.status = ?'); args.push(filter.status) }
  if (scoped) { where.push('p.user_id = ?'); args.push(user.id) }

  const { results } = await db
    .prepare(
      `SELECT i.*, a.id AS app_id, a.stage AS app_stage, a.job_id,
              c.id AS candidate_id, c.first_name, c.last_name, c.email,
              j.title AS job_title, st.name AS scorecard_name,
              (SELECT COUNT(*) FROM interview_participants ip WHERE ip.interview_id = i.id) AS panel_count,
              (SELECT COUNT(*) FROM feedback f WHERE f.interview_id = i.id AND f.status = 'submitted') AS feedback_count,
              (SELECT COUNT(*) FROM interview_participants ip2 LEFT JOIN feedback f2
                  ON f2.interview_id = ip2.interview_id AND f2.interviewer_id = ip2.user_id
                WHERE ip2.interview_id = i.id AND (f2.id IS NULL OR f2.status != 'submitted')) AS outstanding_feedback
         FROM interviews i
         JOIN applications a ON a.id = i.application_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
         LEFT JOIN scorecard_templates st ON st.id = i.scorecard_template_id
         ${scoped ? 'JOIN interview_participants p ON p.interview_id = i.id' : ''}
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY CASE i.status
                   WHEN 'scheduled' THEN 0 WHEN 'confirmed' THEN 0 WHEN 'feedback_pending' THEN 1
                   WHEN 'completed' THEN 1 ELSE 2 END,
                 COALESCE(i.scheduled_at, i.created_at)`
    )
    .bind(...args)
    .all<any>()

  const counts = results.reduce((acc: any, r: any) => {
    acc[r.status] = (acc[r.status] || 0) + 1
    return acc
  }, {})

  return { interviews: results, counts }
}

export const getInterview = async (db: D1Database, id: number) => {
  const interview = await db
    .prepare(
      `SELECT i.*, a.id AS app_id, a.stage AS app_stage, a.status AS app_status, a.job_id,
              c.id AS candidate_id, c.first_name, c.last_name, c.email, c.headline,
              j.title AS job_title, j.code AS job_code, st.name AS scorecard_name, st.criteria AS scorecard_criteria,
              st.required AS scorecard_required
         FROM interviews i
         JOIN applications a ON a.id = i.application_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
         LEFT JOIN scorecard_templates st ON st.id = i.scorecard_template_id
        WHERE i.id = ?`
    )
    .bind(id)
    .first<any>()
  if (!interview) return null

  const panel = await db
    .prepare(
      `SELECT p.*, u.name, u.email, u.title FROM interview_participants p
         JOIN users u ON u.id = p.user_id WHERE p.interview_id = ?`
    )
    .bind(id)
    .all<any>()

  const feedback = await db
    .prepare(
      `SELECT f.*, u.name AS interviewer_name FROM feedback f
         JOIN users u ON u.id = f.interviewer_id WHERE f.interview_id = ?`
    )
    .bind(id)
    .all<any>()

  const { results: users } = await db
    .prepare("SELECT id, name, role FROM users WHERE active = 1 AND role IN ('interviewer','hiring_manager','recruiter','admin')")
    .all<any>()

  return {
    interview: {
      ...interview,
      criteria: parseJson<any[]>(interview.scorecard_criteria, [])
    },
    panel: panel.results,
    feedback: feedback.results.map((f: any) => ({ ...f, scores: parseJson<any[]>(f.scores_json, []) })),
    users
  }
}

/* -------------------------------------------------------------------- offers */
export const listOffers = async (db: D1Database, filter: { status?: string } = {}) => {
  const where: string[] = []
  const args: unknown[] = []
  if (filter.status) { where.push('o.status = ?'); args.push(filter.status) }
  const { results } = await db
    .prepare(
      `SELECT o.*, a.id AS app_id, a.job_id, a.stage AS app_stage,
              c.id AS candidate_id, c.first_name, c.last_name, c.email,
              j.title AS job_title, j.code AS job_code,
              ap.name AS approver_name, cu.name AS creator_name
         FROM offers o
         JOIN applications a ON a.id = o.application_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
         LEFT JOIN users ap ON ap.id = o.approved_by
         LEFT JOIN users cu ON cu.id = o.created_by
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY CASE o.status
                   WHEN 'approval_pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'released' THEN 2 ELSE 3 END,
                 o.updated_at DESC`
    )
    .bind(...args)
    .all<any>()
  return { offers: results }
}

/* ---------------------------------------------------------------- onboarding */
export const listOnboarding = async (db: D1Database) => {
  const { results } = await db
    .prepare(
      `SELECT o.*, a.id AS app_id, c.first_name, c.last_name, c.email,
              j.title AS job_title, j.location, j.code AS job_code
         FROM onboarding o
         JOIN applications a ON a.id = o.application_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
        ORDER BY CASE o.status WHEN 'joined' THEN 3 ELSE 0 END, o.updated_at DESC`
    )
    .all<any>()
  return {
    items: results.map((o: any) => ({ ...o, tasks: parseJson<any[]>(o.tasks_json, []) }))
  }
}

/* --------------------------------------------------------------------- pools */
export const listPools = async (db: D1Database) => {
  const { results: pools } = await db
    .prepare(
      `SELECT p.*, u.name AS owner_name,
              (SELECT COUNT(*) FROM talent_pool_members m WHERE m.pool_id = p.id) AS members,
              (SELECT COUNT(*) FROM talent_pool_members m WHERE m.pool_id = p.id AND m.re_engagement = 'interested') AS interested,
              (SELECT COUNT(*) FROM talent_pool_members m WHERE m.pool_id = p.id
                AND (m.re_engagement = 'not_contacted')) AS not_contacted
         FROM talent_pools p LEFT JOIN users u ON u.id = p.owner_id
        ORDER BY p.id`
    )
    .all<any>()
  const { results: members } = await db
    .prepare(
      `SELECT m.*, c.first_name, c.last_name, c.email, c.headline, c.location, c.consent_status,
              c.experience_years, c.expected_salary
         FROM talent_pool_members m JOIN candidates c ON c.id = m.candidate_id
        ORDER BY m.created_at DESC`
    )
    .all<any>()
  return { pools, members }
}

/* ------------------------------------------------------------------- comms */
export const listCommunications = async (db: D1Database, filter: { status?: string; candidateId?: number } = {}) => {
  const where: string[] = []
  const args: unknown[] = []
  if (filter.status) { where.push('m.status = ?'); args.push(filter.status) }
  if (filter.candidateId) { where.push('m.candidate_id = ?'); args.push(filter.candidateId) }

  const { results: messages } = await db
    .prepare(
      `SELECT m.*, c.first_name, c.last_name, t.name AS template_name, j.title AS job_title, u.name AS sender_name
         FROM messages m
         JOIN candidates c ON c.id = m.candidate_id
         LEFT JOIN message_templates t ON t.id = m.template_id
         LEFT JOIN applications a ON a.id = m.application_id
         LEFT JOIN jobs j ON j.id = a.job_id
         LEFT JOIN users u ON u.id = m.created_by
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY m.id DESC LIMIT 200`
    )
    .bind(...args)
    .all<any>()

  const { results: templates } = await db
    .prepare('SELECT * FROM message_templates ORDER BY category, name')
    .all<any>()

  const counts = await db
    .prepare("SELECT status, COUNT(*) AS n FROM messages GROUP BY status")
    .all<any>()

  return {
    messages,
    templates,
    counts: counts.results.reduce((acc: any, r: any) => { acc[r.status] = Number(r.n); return acc }, {})
  }
}

/* ------------------------------------------------------------------ sharing */
export const candidatesForPicker = async (db: D1Database, q?: string) => {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.consent_status, c.headline
         FROM candidates c WHERE c.status = 'active'
         ${q ? "AND (c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ?)" : ''}
        ORDER BY c.first_name LIMIT 60`
    )
    .bind(...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []))
    .all<any>()
  return results
}

export const activeApplicationsForJob = async (db: D1Database, jobId: number) => {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.stage, a.status, c.first_name, c.last_name
         FROM applications a JOIN candidates c ON c.id = a.candidate_id
        WHERE a.job_id = ? AND a.status = 'active' ORDER BY c.first_name`
    )
    .bind(jobId)
    .all<any>()
  return results
}

export const stageIndexHelper = stageIndex
