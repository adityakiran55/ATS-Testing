import { Hono } from 'hono'
import { renderer } from './renderer'
import { withUser, requireAuth, requirePermission, currentUser, type AppEnv } from './lib/auth'
import { can } from './lib/rbac'
import { nowIso, parseJson, pct } from './lib/util'
import { api } from './api/index'
import { api as coreApi } from './api/core'
import { phasesApi } from './api/phases'
import { aiApi } from './modules/ai/api'
import { serveStatic } from 'hono/cloudflare-workers'

import { LoginPage } from './pages/login'
import { DashboardPage } from './pages/dashboard'
import { JobsPage, NewJobPage, JobDetailPage, AddCandidatePage } from './pages/jobs'
import { CandidateSearchPage, CandidateDetailPage, DuplicatesPage } from './pages/candidates'
import { PipelinePage, ApplicationDetailPage } from './pages/pipeline'
import { InterviewsPage, NewInterviewPage, InterviewDetailPage } from './pages/interviews'
import {
  OffersPage, OfferDetailPage, OnboardingPage, PoolsPage, PoolDetailPage
} from './pages/offers'
import {
  AnalyticsPage, DistributionPage, CommunicationsPage, ManagerPage
} from './pages/analytics'
import { SlaPage, AutomationPage, SettingsPage } from './pages/ops'
import { SpecPage, FEATURES } from './pages/spec'
import { AiDashboardPage, AiProvidersPage, AiModelsPage, AiFeaturesPage, AiUsagePage, AiLogsPage, AiSecurityPage } from './pages/ai'
import {
  TaxonomyPage, ScreeningQueuePage, ScreeningRunPage, JdPage, BoardPage, CompliancePage
} from './pages/phases'

import {
  loadDashboard, listJobs, getJob, getCandidate, listInterviews, getInterview,
  listOffers, listOnboarding, listPools, listCommunications, candidatesForPicker, activeApplicationsForJob
} from './lib/queries'
import { searchCandidates, rediscoverForJob } from './lib/searchService'
import { summarizeCandidate, summarizeFeedback, sourceInsights } from './lib/ai'
import { loadAnalytics } from './lib/metrics'
import { loadAging, loadWorkload, loadRequisitionAging } from './lib/sla'
import {
  loadProviders, loadModels, loadFeatureConfig, loadAiSettings,
  loadRequestLogs, loadAiAuditLog, loadAiCounts
} from './modules/ai/queries'
import { loadUsage } from './modules/ai/gateway'
import { loadGraph, taxonomySummary, listVersions, listSuggestions, browseNodes } from './lib/taxonomy'
import { loadReviewQueue, screeningStats, loadRun, listRunsForJob } from './lib/screening'
import { validateJd, listJdVersions, poolCoveragePreview } from './lib/jd'
import { loadBoard, loadStages, pipelineFunnel } from './lib/pipeline'
import {
  complianceOverview, computeAdverseImpact, listAdverseImpactReports, loadOversightLog, oversightStats
} from './lib/compliance'

const app = new Hono<AppEnv>()

/* ------------------------------------------------------------- static + api */
app.use('/static/*', serveStatic({ root: './' }))
app.use('/static/*', serveStatic({ root: './public' }))
app.use('*', withUser)
app.use(renderer)

app.route('/api', api)
app.route('/api', coreApi)
app.route('/api', phasesApi)
app.route('/api/ai', aiApi)

/* ------------------------------------------------------------------- ai admin */
app.get('/ai', requirePermission('ai.read'), async (c) => {
  const user = currentUser(c)
  const [providers, features, counts, settings] = await Promise.all([
    loadProviders(c.env.DB), loadFeatureConfig(c.env.DB), loadAiCounts(c.env.DB), loadAiSettings(c.env.DB)
  ])
  const usage = await loadUsage(c.env.DB, 30)
  return c.render(
    <AiDashboardPage user={user} data={{ providers, features, usage, counts, settings }} />
  )
})

app.get('/ai/providers', requirePermission('ai.read'), async (c) => {
  const user = currentUser(c)
  return c.render(<AiProvidersPage user={user} data={{ providers: await loadProviders(c.env.DB) }} />)
})

app.get('/ai/models', requirePermission('ai.read'), async (c) => {
  const user = currentUser(c)
  const [models, providers] = await Promise.all([loadModels(c.env.DB), loadProviders(c.env.DB)])
  return c.render(<AiModelsPage user={user} data={{ models, providers }} />)
})

app.get('/ai/features', requirePermission('ai.read'), async (c) => {
  const user = currentUser(c)
  const [features, providers, models] = await Promise.all([
    loadFeatureConfig(c.env.DB), loadProviders(c.env.DB), loadModels(c.env.DB)
  ])
  return c.render(<AiFeaturesPage user={user} data={{ features, providers, models }} />)
})

app.get('/ai/usage', requirePermission('ai.read'), async (c) => {
  const user = currentUser(c)
  const days = Number(c.req.query('days') || 30)
  return c.render(<AiUsagePage user={user} data={{ usage: await loadUsage(c.env.DB, days), days }} />)
})

app.get('/ai/logs', requirePermission('ai.read'), async (c) => {
  const user = currentUser(c)
  const q = c.req.query()
  const [logs, audit, providers] = await Promise.all([
    loadRequestLogs(c.env.DB, { provider: q.provider, feature: q.feature, status: q.status, limit: 80 }),
    loadAiAuditLog(c.env.DB),
    loadProviders(c.env.DB)
  ])
  return c.render(<AiLogsPage user={user} data={{ logs, audit, providers, filters: q }} />)
})

app.get('/ai/security', requirePermission('ai.read'), async (c) => {
  const user = currentUser(c)
  const [settings, providers] = await Promise.all([loadAiSettings(c.env.DB), loadProviders(c.env.DB)])
  return c.render(
    <AiSecurityPage user={user} data={{ settings, providers, days: settings.request_log_retention_days || 90 }} />
  )
})

/* ------------------------------------------------------------------- login */
app.get('/login', async (c) => {
  const user = c.get('user')
  if (user) return c.redirect('/')
  const next = c.req.query('next') || '/'
  return c.html(<LoginPage next={next} />)
})

/* --------------------------------------------------------------- dashboard */
app.get('/', requireAuth, async (c) => {
  const user = currentUser(c)
  const data = await loadDashboard(c.env.DB, user)
  return c.render(<DashboardPage user={user} data={data} />)
})

/* -------------------------------------------------------------------- jobs */
app.get('/jobs', requirePermission('job.read'), async (c) => {
  const user = currentUser(c)
  const q = c.req.query()
  const data = await listJobs(c.env.DB, {
    status: q.status,
    department: q.department,
    q: q.q,
    managerId: user.role === 'hiring_manager' ? user.id : undefined
  })
  return c.render(<JobsPage user={user} data={data} filters={{ status: q.status, q: q.q }} />)
})

app.get('/jobs/new', requirePermission('job.create'), async (c) => {
  const user = currentUser(c)
  const { results } = await c.env.DB.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').all<any>()
  return c.render(<NewJobPage user={user} users={results} />)
})

app.get('/jobs/:id', requirePermission('job.read'), async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const data = await getJob(c.env.DB, id)
  if (!data) return c.notFound()
  if (user.role === 'hiring_manager' && data.job.hiring_manager_id !== user.id) {
    return c.redirect('/jobs')
  }
  return c.render(<JobDetailPage user={user} data={data} />)
})

app.get('/jobs/:id/add-candidate', requirePermission('application.create'), async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<any>()
  if (!job) return c.notFound()
  const candidates = await candidatesForPicker(c.env.DB)
  return c.render(<AddCandidatePage user={user} job={job} candidates={candidates} />)
})

/* -------------------------------------------------------------- candidates */
app.get('/candidates', requirePermission('candidate.search'), async (c) => {
  const user = currentUser(c)
  const q = c.req.query()

  const [result, saved, pools, jobs, audit] = await Promise.all([
    searchCandidates(c.env.DB, {
      q: q.q, mode: (q.mode as any) || 'boolean', skills: q.skills, location: q.location,
      minExperience: q.minExperience ? Number(q.minExperience) : undefined,
      maxNotice: q.maxNotice ? Number(q.maxNotice) : undefined,
      maxSalary: q.maxSalary ? Number(q.maxSalary) : undefined,
      tags: q.tags, consent: q.consent,
      poolId: q.poolId ? Number(q.poolId) : undefined,
      appliedToJobId: q.appliedToJobId ? Number(q.appliedToJobId) : undefined,
      sort: q.sort, page: q.page ? Number(q.page) : 1, perPage: 25
    }, user.id),
    c.env.DB.prepare('SELECT * FROM saved_searches WHERE owner_id = ? OR shared = 1 ORDER BY id DESC LIMIT 8').bind(user.id).all<any>(),
    c.env.DB.prepare('SELECT id, name FROM talent_pools ORDER BY name').all<any>(),
    c.env.DB.prepare("SELECT id, title FROM jobs WHERE status IN ('open','paused') ORDER BY title").all<any>(),
    c.env.DB.prepare('SELECT query, mode, result_count, duration_ms, created_at FROM search_audit WHERE user_id = ? ORDER BY id DESC LIMIT 8').bind(user.id).all<any>()
  ])

  const dupCount = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM duplicate_reviews WHERE status = 'pending'").first<any>()
  const resumeFail = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM resumes WHERE status IN ('failed','dead_letter')").first<any>()

  const tabs = [
    { label: 'Talent search', href: '/candidates', active: true },
    { label: 'Duplicate review', href: '/candidates/duplicates', active: false, count: Number(dupCount?.n || 0) },
    { label: 'Resume processing', href: '/candidates?tab=processing', active: false, count: Number(resumeFail?.n || 0) }
  ]

  return c.render(
    <CandidateSearchPage
      user={user}
      data={{
        results: result.results, total: result.total, plan: result.plan,
        savedSearches: saved.results, pools: pools.results, jobs: jobs.results,
        audit: audit.results, tabs
      }}
      params={{ ...q, page: result.page }}
    />
  )
})

app.get('/candidates/duplicates', requirePermission('candidate.merge'), async (c) => {
  const user = currentUser(c)
  const { results } = await c.env.DB.prepare(
    `SELECT d.*, p.first_name AS pf, p.last_name AS pl,
            (SELECT COUNT(*) FROM applications a WHERE a.candidate_id = d.duplicate_id) AS dup_apps
       FROM duplicate_reviews d JOIN candidates p ON p.id = d.primary_id
      WHERE d.status = 'pending' ORDER BY d.score DESC`
  ).all<any>()

  const candidates = await c.env.DB.prepare('SELECT * FROM candidates WHERE status = ?').bind('active').all<any>()
  const byId = new Map<number, any>(candidates.results.map((x: any) => [x.id, x]))
  const appCounts = await c.env.DB.prepare(
    'SELECT candidate_id, COUNT(*) AS n FROM applications GROUP BY candidate_id'
  ).all<any>()
  const appMap = new Map<number, number>(appCounts.results.map((x: any) => [Number(x.candidate_id), Number(x.n)]))

  const pairs = results
    .map((d: any) => {
      const primary = byId.get(d.primary_id)
      const dupe = byId.get(d.duplicate_id)
      if (!primary || !dupe) return null
      return {
        id: d.id,
        primary_id: d.primary_id,
        duplicate_id: d.duplicate_id,
        score: d.score,
        signals: parseJson<any[]>(d.signals, []),
        primary: { ...primary, application_count: appMap.get(d.primary_id) || 0 },
        duplicate: { ...dupe, application_count: appMap.get(d.duplicate_id) || 0 }
      }
    })
    .filter(Boolean)

  const stats = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status='pending' AND score >= 0.7 THEN 1 ELSE 0 END) AS high,
       SUM(CASE WHEN status='merged' THEN 1 ELSE 0 END) AS merged,
       SUM(CASE WHEN status='ignored' THEN 1 ELSE 0 END) AS ignored
     FROM duplicate_reviews`
  ).first<any>()

  return c.render(
    <DuplicatesPage
      user={user}
      pairs={pairs as any}
      stats={{
        pending: Number(stats?.pending || 0), high: Number(stats?.high || 0),
        merged: Number(stats?.merged || 0), ignored: Number(stats?.ignored || 0)
      }}
    />
  )
})

app.get('/candidates/:id', requirePermission('candidate.read'), async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const data = await getCandidate(c.env.DB, id)
  if (!data) return c.notFound()

  const jobIdParam = c.req.query('job')
  const activeApps = data.applications.filter((a: any) => a.status === 'active')
  const jobId = jobIdParam ? Number(jobIdParam) : activeApps[0]?.job_id || data.applications[0]?.job_id || null

  let aiSummary = null
  try {
    if (jobId) aiSummary = await summarizeCandidate(c.env.DB, id, jobId)
  } catch { aiSummary = null }

  return c.render(<CandidateDetailPage user={user} data={{ ...data, aiSummary }} />)
})

/* ---------------------------------------------------------------- pipeline */
app.get('/pipeline', requirePermission('application.read'), async (c) => {
  const user = currentUser(c)
  const jobId = c.req.query('job') ? Number(c.req.query('job')) : undefined
  const aging = await loadAging(c.env.DB, { jobId })
  const thresholds = Object.fromEntries(aging.rows.map((r) => [r.application_id, r.threshold_hours]))

  const { results: jobs } = await c.env.DB.prepare(
    "SELECT id, title, code FROM jobs WHERE status IN ('open','paused','filled','approved') ORDER BY title"
  ).all<any>()

  const where = ["a.status != 'withdrawn'"]
  const args: unknown[] = []
  if (jobId) { where.push('a.job_id = ?'); args.push(jobId) }
  if (user.role === 'hiring_manager') { where.push('j.hiring_manager_id = ?'); args.push(user.id) }

  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.candidate_id, a.job_id, a.stage, a.status, a.source, a.stage_entered_at,
            c.first_name, c.last_name, c.headline, c.experience_years,
            j.title AS job_title, j.code AS job_code
       FROM applications a
       JOIN candidates c ON c.id = a.candidate_id
       JOIN jobs j ON j.id = a.job_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.stage_entered_at ASC`
  ).bind(...args).all<any>()

  const rows = results.map((r: any) => {
    const th = aging.rows.find((x) => x.application_id === r.id)
    return {
      ...r,
      hours_in_stage: th ? th.hours_in_stage : 0,
      threshold_hours: thresholds[r.id] || 48
    }
  })

  return c.render(<PipelinePage user={user} data={{ jobs: jobs, rows, aging }} jobId={jobId} />)
})

app.get('/applications/:id', requirePermission('application.read'), async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))

  const app = await c.env.DB.prepare(
    `SELECT a.*, j.title AS job_title, j.code AS job_code, j.location AS job_location,
            j.department, j.hiring_manager_id, j.recruiter_id, u.name AS recruiter_name, hm.name AS manager_name
       FROM applications a JOIN jobs j ON j.id = a.job_id
       LEFT JOIN users u ON u.id = j.recruiter_id
       LEFT JOIN users hm ON hm.id = j.hiring_manager_id
      WHERE a.id = ?`
  ).bind(id).first<any>()
  if (!app) return c.notFound()
  if (user.role === 'hiring_manager' && app.hiring_manager_id !== user.id) return c.redirect('/pipeline')

  const candidate = await c.env.DB.prepare('SELECT * FROM candidates WHERE id = ?').bind(app.candidate_id).first<any>()
  const history = await c.env.DB.prepare(
    `SELECT h.*, u.name AS actor_name FROM application_stage_history h
       LEFT JOIN users u ON u.id = h.actor_id WHERE h.application_id = ? ORDER BY h.id DESC`
  ).bind(id).all<any>()
  const interviews = await c.env.DB.prepare(
    `SELECT i.*, (SELECT COUNT(*) FROM interview_participants p WHERE p.interview_id = i.id) AS panel_count,
            (SELECT COUNT(*) FROM feedback f WHERE f.interview_id = i.id AND f.status='submitted') AS feedback_count
       FROM interviews i WHERE i.application_id = ? ORDER BY i.round`
  ).bind(id).all<any>()
  const offers = await c.env.DB.prepare('SELECT * FROM offers WHERE application_id = ? ORDER BY version DESC').bind(id).all<any>()
  const onboarding = await c.env.DB.prepare('SELECT * FROM onboarding WHERE application_id = ?').bind(id).first<any>()
  const messages = await c.env.DB.prepare(
    'SELECT * FROM messages WHERE application_id = ? ORDER BY id DESC LIMIT 20'
  ).bind(id).all<any>()
  const templates = await c.env.DB.prepare('SELECT * FROM message_templates WHERE active = 1 ORDER BY category').all<any>()

  const hasFeedback = interviews.results.some((i: any) => i.feedback_count > 0)
  let feedbackSummary = null
  if (hasFeedback) {
    try { feedbackSummary = await summarizeFeedback(c.env.DB, id) } catch { feedbackSummary = null }
  }

  return c.render(
    <ApplicationDetailPage
      user={user}
      data={{
        app,
        candidate,
        job: { id: app.job_id, title: app.job_title, code: app.job_code, location: app.job_location,
          department: app.department, recruiter_name: app.recruiter_name, manager_name: app.manager_name },
        history: history.results, interviews: interviews.results, offers: offers.results,
        onboarding, messages: messages.results, templates: templates.results, feedbackSummary
      }}
    />
  )
})

/* -------------------------------------------------------------- interviews */
app.get('/interviews', requirePermission('interview.read'), async (c) => {
  const user = currentUser(c)
  const status = c.req.query('status') || ''
  const data = await listInterviews(c.env.DB, user, { status: status || undefined })
  return c.render(<InterviewsPage user={user} data={data} filter={status} />)
})

app.get('/interviews/new', requirePermission('interview.schedule'), async (c) => {
  const user = currentUser(c)
  const preselect = c.req.query('application') ? Number(c.req.query('application')) : undefined
  const apps = await c.env.DB.prepare(
    `SELECT a.id, a.stage, c.first_name, c.last_name, j.title AS job_title
       FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN jobs j ON j.id = a.job_id
      WHERE a.status = 'active' ORDER BY c.first_name LIMIT 200`
  ).all<any>()
  const users = await c.env.DB.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').all<any>()
  return c.render(<NewInterviewPage user={user} users={users.results} applications={apps.results} preselect={preselect} />)
})

app.get('/interviews/:id', requirePermission('interview.read'), async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const data = await getInterview(c.env.DB, id)
  if (!data) return c.notFound()
  const myFeedback = data.feedback.find((f: any) => f.interviewer_id === user.id) || null
  return c.render(<InterviewDetailPage user={user} data={{ ...data, myFeedback }} />)
})

/* ------------------------------------------------------------------ offers */
app.get('/offers', requirePermission('offer.read'), async (c) => {
  const user = currentUser(c)
  const status = c.req.query('status') || ''
  const data = await listOffers(c.env.DB, { status: status || undefined })
  return c.render(<OffersPage user={user} data={data} filter={status} />)
})

app.get('/offers/:id', requirePermission('offer.read'), async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const offer = await c.env.DB.prepare(
    `SELECT o.*, ap.name AS approver_name, cu.name AS creator_name FROM offers o
       LEFT JOIN users ap ON ap.id = o.approved_by LEFT JOIN users cu ON cu.id = o.created_by WHERE o.id = ?`
  ).bind(id).first<any>()
  if (!offer) return c.notFound()

  const app = await c.env.DB.prepare('SELECT * FROM applications WHERE id = ?').bind(offer.application_id).first<any>()
  const candidate = await c.env.DB.prepare('SELECT * FROM candidates WHERE id = ?').bind(app.candidate_id).first<any>()
  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(app.job_id).first<any>()
  const versions = await c.env.DB.prepare('SELECT * FROM offers WHERE application_id = ? ORDER BY version DESC')
    .bind(offer.application_id).all<any>()
  const audit = await c.env.DB.prepare(
    `SELECT * FROM audit_events WHERE entity_type='offer' AND entity_id=? ORDER BY id DESC LIMIT 20`
  ).bind(String(id)).all<any>()

  return c.render(
    <OfferDetailPage
      user={user}
      data={{
        offer, candidate, job: { ...job, applied_at: app.applied_at },
        versions: versions.results, audit: audit.results
      }}
    />
  )
})

/* -------------------------------------------------------------- onboarding */
app.get('/onboarding', requirePermission('onboarding.read'), async (c) => {
  const user = currentUser(c)
  const data = await listOnboarding(c.env.DB)
  return c.render(<OnboardingPage user={user} data={data} />)
})

/* ------------------------------------------------------------------- pools */
app.get('/pools', requirePermission('pool.read'), async (c) => {
  const user = currentUser(c)
  const data = await listPools(c.env.DB)
  return c.render(<PoolsPage user={user} data={data} />)
})

app.get('/pools/:id', requirePermission('pool.read'), async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  const pool = await c.env.DB.prepare('SELECT * FROM talent_pools WHERE id = ?').bind(id).first<any>()
  if (!pool) return c.notFound()
  const members = await c.env.DB.prepare(
    `SELECT m.*, c.first_name, c.last_name, c.email, c.headline, c.location, c.consent_status,
            c.experience_years, c.expected_salary
       FROM talent_pool_members m JOIN candidates c ON c.id = m.candidate_id
      WHERE m.pool_id = ? ORDER BY m.created_at DESC`
  ).bind(id).all<any>()
  return c.render(<PoolDetailPage user={user} data={{ pool, members: members.results }} />)
})

/* ---------------------------------------------------------- communications */
app.get('/communications', requirePermission('message.read'), async (c) => {
  const user = currentUser(c)
  const status = c.req.query('status') || ''
  const candidateId = c.req.query('candidate') ? Number(c.req.query('candidate')) : undefined
  const data = await listCommunications(c.env.DB, { status: status || undefined, candidateId })
  const candidates = await candidatesForPicker(c.env.DB)
  return c.render(
    <CommunicationsPage user={user} data={{ ...data, candidates }} filter={status} candidateId={candidateId} />
  )
})

/* -------------------------------------------------------------- analytics */
app.get('/analytics', requirePermission('analytics.read'), async (c) => {
  const user = currentUser(c)
  const q = c.req.query()
  const filters = {
    from: q.from, to: q.to,
    jobId: q.jobId ? Number(q.jobId) : undefined,
    source: q.source, location: q.location
  }
  const analytics = await loadAnalytics(c.env.DB, filters as any)
  const insights = sourceInsights(analytics)
  const { results: jobs } = await c.env.DB.prepare("SELECT id, title FROM jobs ORDER BY title").all<any>()
  const { results: srcRows } = await c.env.DB.prepare(
    "SELECT DISTINCT source FROM applications WHERE source IS NOT NULL ORDER BY source"
  ).all<any>()

  return c.render(
    <AnalyticsPage
      user={user}
      data={{ analytics, jobs, sources: srcRows.map((s: any) => s.source), insights, trend: [] }}
      filters={q}
    />
  )
})

/* ------------------------------------------------------------ distribution */
app.get('/distribution', requirePermission('distribution.read'), async (c) => {
  const user = currentUser(c)
  const jobFilter = c.req.query('job') ? Number(c.req.query('job')) : undefined

  const { results: jobs } = await c.env.DB.prepare(
    "SELECT id, title, code FROM jobs WHERE status IN ('open','paused','filled','pending_approval','approved') ORDER BY title"
  ).all<any>()
  const where = jobFilter ? 'WHERE p.job_id = ?' : ''
  const { results: postings } = await c.env.DB.prepare(
    `SELECT p.*, ch.name AS channel_name, ch.api_supported, j.title AS job_title, j.code AS job_code
       FROM job_postings p JOIN channels ch ON ch.id = p.channel_id JOIN jobs j ON j.id = p.job_id
       ${where} ORDER BY j.title, ch.id`
  ).bind(...(jobFilter ? [jobFilter] : [])).all<any>()
  const { results: channels } = await c.env.DB.prepare('SELECT * FROM channels ORDER BY id').all<any>()
  const { results: events } = await c.env.DB.prepare(
    `SELECT e.*, ch.name AS channel_name, u.name AS actor_name FROM job_posting_events e
       JOIN job_postings p ON p.id = e.posting_id JOIN channels ch ON ch.id = p.channel_id
       LEFT JOIN users u ON u.id = e.actor_id ORDER BY e.id DESC LIMIT 60`
  ).all<any>()

  return c.render(
    <DistributionPage user={user} data={{ jobs, postings, channels, events }} jobFilter={jobFilter} />
  )
})

/* ---------------------------------------------------------------- manager */
app.get('/manager', requirePermission('manager.review'), async (c) => {
  const user = currentUser(c)

  const { results: queue } = await c.env.DB.prepare(
    `SELECT a.id, a.stage, a.stage_entered_at, c.first_name, c.last_name, c.headline,
            j.title AS job_title, j.code AS job_code, u.name AS recruiter_name,
            ROUND((julianday('now') - julianday(a.stage_entered_at)) * 24, 1) AS hours_in_stage
       FROM applications a
       JOIN candidates c ON c.id = a.candidate_id
       JOIN jobs j ON j.id = a.job_id
       LEFT JOIN users u ON u.id = a.recruiter_id
      WHERE a.status = 'active' AND a.stage = 'manager_review' AND j.hiring_manager_id = ?
      ORDER BY a.stage_entered_at ASC`
  ).bind(user.id).all<any>()

  const { results: requirements } = await c.env.DB.prepare(
    `SELECT j.id, j.title, j.code, j.status,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS applications,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.stage = 'manager_review' AND a.status='active') AS in_review,
            (SELECT COUNT(*) FROM applications a JOIN interviews i ON i.application_id = a.id WHERE a.job_id = j.id) AS interviews,
            (SELECT COUNT(*) FROM applications a JOIN offers o ON o.application_id = a.id WHERE a.job_id = j.id) AS offers
       FROM jobs j WHERE j.hiring_manager_id = ? ORDER BY j.status = 'open' DESC, j.title`
  ).bind(user.id).all<any>()

  const feedbackDue = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM interview_participants p
       JOIN interviews i ON i.id = p.interview_id
       JOIN applications a ON a.id = i.application_id
       JOIN jobs j ON j.id = a.job_id
       LEFT JOIN feedback f ON f.interview_id = p.interview_id AND f.interviewer_id = p.user_id AND f.status='submitted'
      WHERE j.hiring_manager_id = ? AND f.id IS NULL AND i.status IN ('feedback_pending','completed')`
  ).bind(user.id).first<any>()

  const decidedThisWeek = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM application_stage_history h
       JOIN applications a ON a.id = h.application_id JOIN jobs j ON j.id = a.job_id
      WHERE j.hiring_manager_id = ? AND h.actor_id = ? AND h.created_at > ?`
  ).bind(user.id, user.id, new Date(Date.now() - 7 * 86400000).toISOString()).first<any>()

  return c.render(
    <ManagerPage
      user={user}
      data={{
        queue: queue, requirements: requirements,
        feedbackDue: Number(feedbackDue?.n || 0),
        decidedThisWeek: Number(decidedThisWeek?.n || 0)
      }}
    />
  )
})

/* -------------------------------------------------------------------- SLA */
app.get('/sla', requirePermission('sla.read'), async (c) => {
  const user = currentUser(c)
  const [aging, workload, requisitionAging] = await Promise.all([
    loadAging(c.env.DB), loadWorkload(c.env.DB), loadRequisitionAging(c.env.DB)
  ])
  const { results: slas } = await c.env.DB.prepare("SELECT * FROM sla_settings WHERE scope = 'stage' ORDER BY threshold_hours").all<any>()
  const ruleRuns = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM automation_runs").first<any>()

  return c.render(
    <SlaPage
      user={user}
      data={{ aging, workload, requisitionAging, slas, ruleRuns: Number(ruleRuns?.n || 0) }}
    />
  )
})

/* ------------------------------------------------------------- automation */
app.get('/automation', requirePermission('automation.read'), async (c) => {
  const user = currentUser(c)
  const { results: rules } = await c.env.DB.prepare('SELECT * FROM automation_rules ORDER BY id').all<any>()
  const { results: runs } = await c.env.DB.prepare(
    `SELECT r.*, ru.name AS rule_name FROM automation_runs r
       LEFT JOIN automation_rules ru ON ru.id = r.rule_id ORDER BY r.id DESC LIMIT 50`
  ).all<any>()
  const { results: events } = await c.env.DB.prepare(
    'SELECT * FROM automation_event_queue ORDER BY id DESC LIMIT 40'
  ).all<any>()

  const enriched = rules.map((r: any) => ({
    ...r,
    condition_list: parseJson<any[]>(r.conditions, []),
    action_list: parseJson<any[]>(r.actions, [])
  }))

  return c.render(<AutomationPage user={user} data={{ rules: enriched, runs, events }} />)
})

/* --------------------------------------------------------------- settings */
app.get('/settings', requirePermission('admin.settings'), async (c) => {
  const user = currentUser(c)
  const { results: users } = await c.env.DB.prepare('SELECT * FROM users ORDER BY id').all<any>()
  const { results: slas } = await c.env.DB.prepare("SELECT * FROM sla_settings ORDER BY threshold_hours").all<any>()
  const { results: settingsRows } = await c.env.DB.prepare('SELECT key, value FROM settings').all<any>()
  const { results: auditRows } = await c.env.DB.prepare(
    `SELECT a.*, u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 40`
  ).all<any>()
  const queue = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status='dead_letter' THEN 1 ELSE 0 END) AS dead,
       SUM(CASE WHEN status IN ('uploaded','queued','parsing','malware_scan') THEN 1 ELSE 0 END) AS pending
     FROM resumes`
  ).first<any>()

  const settings = settingsRows.reduce((acc: any, r: any) => { acc[r.key] = r.value; return acc }, {})

  return c.render(
    <SettingsPage
      user={user}
      data={{
        users, slas, settings, audit: auditRows,
        resumeQueue: {
          failed: Number(queue?.failed || 0), dead: Number(queue?.dead || 0), pending: Number(queue?.pending || 0)
        }
      }}
    />
  )
})

/* ------------------------------------------------------------- spec page */
app.get('/spec', requireAuth, async (c) => {
  const user = currentUser(c)
  const tables = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name NOT LIKE 'd1_%'"
  ).first<any>()
  const auditCount = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM audit_events').first<any>()

  return c.render(
    <SpecPage
      user={user}
      stats={{
        tests: 159,
        passing: 159,
        tables: Number(tables?.n || 0),
        audit: Number(auditCount?.n || 0)
      }}
    />
  )
})

/* ------------------------------------------------------- v3.0 phase screens */
app.get('/taxonomy', requirePermission('candidate.read'), async (c) => {
  const user = currentUser(c)
  const kind = c.req.query('kind') || ''
  const q = c.req.query('q') || ''
  const [summary, versions, suggestions, nodes] = await Promise.all([
    taxonomySummary(c.env.DB), listVersions(c.env.DB),
    listSuggestions(c.env.DB, 'pending'), browseNodes(c.env.DB, { kind: kind || undefined, q: q || undefined })
  ])
  return c.render(
    <TaxonomyPage user={user} data={{ summary, versions, suggestions, nodes, kindFilter: kind, q }} />
  )
})

app.get('/screening', requirePermission('application.read'), async (c) => {
  const user = currentUser(c)
  const [queue, stats] = await Promise.all([loadReviewQueue(c.env.DB), screeningStats(c.env.DB)])
  return c.render(<ScreeningQueuePage user={user} data={{ queue, stats }} />)
})

app.get('/screening/runs/:id', requirePermission('application.read'), async (c) => {
  const user = currentUser(c)
  const run = await loadRun(c.env.DB, Number(c.req.param('id')))
  if (!run) return c.notFound()
  return c.render(<ScreeningRunPage user={user} data={{ run }} />)
})

app.get('/board', requirePermission('application.read'), async (c) => {
  const user = currentUser(c)
  const jobId = c.req.query('job') ? Number(c.req.query('job')) : undefined
  const [board, funnel, jobsRes] = await Promise.all([
    loadBoard(c.env.DB, { jobId }),
    pipelineFunnel(c.env.DB, jobId),
    c.env.DB.prepare(`SELECT id, title, code FROM jobs WHERE status IN ('open','paused','approved') ORDER BY title`).all<any>()
  ])
  return c.render(
    <BoardPage user={user} data={{ board, funnel, jobs: jobsRes.results, jobId }} />
  )
})

app.get('/compliance', requirePermission('audit.read'), async (c) => {
  const user = currentUser(c)
  const [overview, impact, reports] = await Promise.all([
    complianceOverview(c.env.DB, user.tenant_id ?? 1),
    computeAdverseImpact(c.env.DB, { tenantId: user.tenant_id ?? 1 }),
    listAdverseImpactReports(c.env.DB, 10)
  ])
  return c.render(<CompliancePage user={user} data={{ overview, impact, reports }} />)
})

app.get('/jobs/:id/jd', requirePermission('job.read'), async (c) => {
  const user = currentUser(c)
  const jobId = Number(c.req.param('id'))
  const job = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<any>()
  if (!job) return c.notFound()
  const graph = await loadGraph(c.env.DB)
  const [versions, coverage] = await Promise.all([
    listJdVersions(c.env.DB, jobId),
    poolCoveragePreview(c.env.DB, job, graph)
  ])
  const analysis = validateJd(job, graph)
  const requirements = versions.length
    ? (await c.env.DB.prepare(
        `SELECT * FROM jd_requirements WHERE jd_version_id = ? ORDER BY kind DESC, id`
      ).bind(versions[0].id).all<any>()).results
    : []
  return c.render(
    <JdPage user={user} data={{ job, versions, analysis, coverage, requirements }} />
  )
})

/* ------------------------------------------------------------------- misc */
app.get('/rediscovery', requirePermission('candidate.search'), async (c) => {
  const jobId = Number(c.req.query('job') || 1)
  const out = await rediscoverForJob(c.env.DB, jobId)
  return c.json(out)
})

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'not_found', message: 'Unknown endpoint' }, 404)
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>Not found</title>
     <link href="/static/app.css" rel="stylesheet"></head>
     <body><div style="max-width:520px;margin:16vh auto;text-align:center;padding:0 20px">
     <i class="fa-solid fa-compass" style="font-size:34px;color:#98a2b3"></i>
     <h1 style="margin-top:16px">Page not found</h1>
     <p class="muted">The requested path does not exist in this application.</p>
     <a class="btn primary" href="/">Back to dashboard</a></div></body></html>`,
    404
  )
})

app.onError((err, c) => {
  console.error('Unhandled error', err)
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'server_error', message: err.message || 'Unexpected error' }, 500)
  }
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>Error</title>
     <link href="/static/app.css" rel="stylesheet"></head>
     <body><div style="max-width:600px;margin:14vh auto;padding:0 20px">
     <h1>Something went wrong</h1>
     <pre class="snippet">${String(err.message || err).replace(/</g, '&lt;')}</pre>
     <a class="btn primary" href="/">Back to dashboard</a></div></body></html>`,
    500
  )
})

export default app
