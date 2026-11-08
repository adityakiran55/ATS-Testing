import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { AppEnv } from '../lib/auth'
import {
  verifyPassword, createSession, setSessionCookie, clearSession, currentUser,
  requireAuth, hashPassword
} from '../lib/auth'
import { can } from '../lib/rbac'
import { audit, emitEvent } from '../lib/audit'
import { nowIso, addDays, parseJson, hashString, pct, slug } from '../lib/util'
import { JOB_TRANSITIONS, validateStageMove, STAGE_ORDER, stageIndex, OFFER_TRANSITIONS, ONBOARDING_TRANSITIONS, INTERVIEW_TRANSITIONS, POSTING_TRANSITIONS, assertTransition } from '../lib/lifecycle'
import { processResume, drainQueue, retryResume, parseResume, buildSearchBlob } from '../lib/resume'
import { refreshDuplicateQueue, mergePreview, executeMerge, revertMerge } from '../lib/dedupe'
import { escalateOverdue, loadAging } from '../lib/sla'
import { loadAnalytics } from '../lib/metrics'
import { summarizeCandidate, compareCandidates, summarizeFeedback, interpretQuery, sourceInsights } from '../lib/ai'

export const api = new Hono<AppEnv>()

/* =========================================================== helpers/routes */
api.get('/health', (c) => c.json({ ok: true, at: nowIso() }))

/* --------------------------------------------------------------- auth */
api.post('/auth/login', async (c) => {
  // Accept JSON (fetch client) or urlencoded form submissions
  let body: any = {}
  const ct = c.req.header('content-type') || ''
  if (ct.includes('application/json')) {
    body = await c.req.json<any>().catch(() => ({}))
  } else {
    const form = await c.req.parseBody().catch(() => ({} as any))
    body = form || {}
  }
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  const next = String(body.next || '/')

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE lower(email) = ? AND active = 1')
    .bind(email)
    .first<any>()

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: 'invalid_credentials', message: 'Incorrect email or password' }, 401)
  }

  const token = await createSession(c.env.DB, user.id)
  setSessionCookie(c, token)
  await audit(c.env.DB, {
    entityType: 'user', entityId: user.id, action: 'login', actorId: user.id,
    meta: { email: user.email }
  })
  // `message` + `redirect` drive the client runtime: the client prefers
  // out.redirect and suppresses the generic "Saved" toast on navigation.
  return c.json({
    ok: true,
    id: user.id,
    name: user.name,
    role: user.role,
    message: `Welcome back, ${String(user.name).split(' ')[0]}`,
    redirect: next || '/'
  })
})

api.post('/auth/logout', async (c) => {
  const token = getCookie(c, 'ats_session')
  await clearSession(c, token)
  return c.redirect('/login')
})

api.get('/me', requireAuth, (c) => c.json({ user: currentUser(c) }))

api.get('/permissions', requireAuth, (c) => {
  const u = currentUser(c)
  return c.json({ role: u.role, permissions: RAISE_MATRIX(u.role) })
})

const RAISE_MATRIX = (role: string) => {
  const probe = [
    'job.read', 'job.create', 'job.edit', 'job.submit', 'job.approve', 'job.close',
    'candidate.read', 'candidate.create', 'candidate.edit', 'candidate.delete', 'candidate.merge',
    'candidate.search', 'candidate.export', 'candidate.consent',
    'application.read', 'application.create', 'application.move', 'application.reject',
    'interview.read', 'interview.schedule', 'interview.feedback.submit', 'interview.feedback.read',
    'offer.read', 'offer.create', 'offer.approve', 'offer.release', 'offer.respond',
    'onboarding.read', 'onboarding.manage', 'distribution.read', 'distribution.manage',
    'message.read', 'message.send', 'template.manage', 'automation.read', 'automation.manage',
    'pool.read', 'pool.manage', 'analytics.read', 'analytics.export', 'sla.read', 'sla.manage',
    'admin.users', 'admin.settings', 'audit.read', 'spec.read', 'manager.review'
  ]
  return probe.filter((p) => can(role as any, p as any))
}

/* --------------------------------------------------------------- jobs */
api.post('/jobs', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'job.create')) return c.json({ error: 'forbidden', message: 'You cannot create requisitions' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))

  const title = String(b.title || '').trim()
  const department = String(b.department || '').trim()
  const location = String(b.location || '').trim()
  if (!title || !department || !location) {
    return c.json({ error: 'validation', message: 'Title, department and location are required' }, 400)
  }
  const countRow = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<any>()
  const code = (b.code && String(b.code).trim()) || `${slug(department).slice(0, 3).toUpperCase()}-${1000 + Number(countRow?.n || 0) + 1}`

  const dup = await c.env.DB.prepare('SELECT id FROM jobs WHERE code = ?').bind(code).first<any>()
  if (dup) return c.json({ error: 'duplicate_code', message: `Requisition code ${code} already exists` }, 409)

  const skillsList = (v: any) =>
    JSON.stringify(String(v || '').split(',').map((s) => s.trim()).filter(Boolean))

  const res = await c.env.DB.prepare(
    `INSERT INTO jobs (code,title,department,location,work_mode,employment_type,seniority,description,requirements,
       must_have_skills,nice_to_have,salary_min,salary_max,openings,priority,recruiter_id,hiring_manager_id,created_by,target_fill_date,status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft')`
  )
    .bind(
      code, title, department, location,
      b.work_mode || 'hybrid', b.employment_type || 'full_time', b.seniority || null,
      b.description || '', b.requirements || '',
      skillsList(b.must_have_skills), skillsList(b.nice_to_have),
      b.salary_min ? Number(b.salary_min) : null, b.salary_max ? Number(b.salary_max) : null,
      b.openings ? Number(b.openings) : 1, b.priority || 'normal',
      b.recruiter_id ? Number(b.recruiter_id) : null,
      b.hiring_manager_id ? Number(b.hiring_manager_id) : null,
      u.id, b.target_fill_date || null
    )
    .run()

  const id = Number(res.meta.last_row_id)
  await audit(c.env.DB, {
    entityType: 'job', entityId: id, action: 'created', actorId: u.id,
    newValue: { status: 'draft', title, code }
  })
  return c.json({ id, code, message: `Requisition ${code} created in Draft` }, 201)
})

api.patch('/jobs/:id', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'job.edit')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  const before = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<any>()
  if (!before) return c.json({ error: 'not_found', message: 'Requisition not found' }, 404)
  const b = await c.req.json<any>().catch(() => ({}))
  const allowed = ['title', 'department', 'location', 'work_mode', 'employment_type', 'seniority', 'description',
    'requirements', 'salary_min', 'salary_max', 'openings', 'priority', 'recruiter_id', 'hiring_manager_id', 'target_fill_date']
  const patch: Record<string, any> = {}
  for (const k of allowed) if (b[k] !== undefined) patch[k] = b[k] === '' ? null : b[k]
  if (b.must_have_skills !== undefined) {
    patch.must_have_skills = JSON.stringify(String(b.must_have_skills).split(',').map((s) => s.trim()).filter(Boolean))
  }
  if (b.nice_to_have !== undefined) {
    patch.nice_to_have = JSON.stringify(String(b.nice_to_have).split(',').map((s) => s.trim()).filter(Boolean))
  }
  if (!Object.keys(patch).length) return c.json({ error: 'validation', message: 'No fields to update' }, 400)

  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ')
  await c.env.DB.prepare(`UPDATE jobs SET ${sets}, updated_at = ? WHERE id = ?`)
    .bind(...Object.values(patch), nowIso(), id).run()

  await audit(c.env.DB, { entityType: 'job', entityId: id, action: 'updated', actorId: u.id, previousValue: before, newValue: patch })
  return c.json({ id, message: 'Requisition updated' })
})

api.post('/jobs/:id/transition', requireAuth, async (c) => {
  const u = currentUser(c)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  const to = String(b.to || '')
  const reason = b.reason ? String(b.reason) : null

  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<any>()
  if (!job) return c.json({ error: 'not_found', message: 'Requisition not found' }, 404)

  const transition = (JOB_TRANSITIONS[job.status] || []).find((t) => t.to === to)
  if (!transition) {
    return c.json({
      error: 'invalid_transition',
      message: `Cannot move a ${job.status} requisition to ${to}. Allowed: ${(JOB_TRANSITIONS[job.status] || []).map((t) => t.to).join(', ') || 'none'}`
    }, 422)
  }
  if (!can(u.role, transition.perm)) {
    return c.json({ error: 'forbidden', message: `Your role cannot ${transition.label.toLowerCase()}` }, 403)
  }
  if (transition.requiresReason && !reason) {
    return c.json({ error: 'reason_required', message: `A reason is required to ${transition.label.toLowerCase()}` }, 400)
  }

  const stamp = nowIso()
  const extras: string[] = []
  const args: any[] = []
  if (to === 'submitted') { extras.push('submitted_at = ?'); args.push(stamp) }
  if (to === 'approved') { extras.push('approved_at = ?'); args.push(stamp) }
  if (to === 'open') { extras.push('opened_at = COALESCE(opened_at, ?)'); args.push(stamp) }
  if (to === 'filled') { extras.push('filled_at = ?', 'closed_at = ?'); args.push(stamp, stamp) }
  if (['closed', 'cancelled'].includes(to)) { extras.push('closed_at = ?'); args.push(stamp) }
  if (['closed', 'cancelled'].includes(to)) { extras.push('close_reason = ?'); args.push(reason) }

  await c.env.DB.prepare(`UPDATE jobs SET status = ?, updated_at = ?${extras.length ? ', ' + extras.join(', ') : ''} WHERE id = ?`)
    .bind(to, stamp, ...args, id).run()

  if (['approved', 'rejected', 'changes_requested'].includes(to) || to === 'draft') {
    if (job.status === 'pending_approval') {
      const decision = to === 'approved' ? 'approved' : to === 'draft' ? 'changes_requested' : 'rejected'
      await c.env.DB.prepare('INSERT INTO job_approvals (job_id, step, actor_id, decision, reason, created_at) VALUES (?,?,?,?,?,?)')
        .bind(id, 1, u.id, decision, reason, stamp).run()
    }
  }

  // requisition close → withdraw live postings
  if (['closed', 'cancelled', 'filled'].includes(to)) {
    await c.env.DB.prepare(
      `UPDATE job_postings SET status = 'withdrawn', withdrawn_at = ?, updated_at = ? WHERE job_id = ? AND status IN ('published','queued')`
    ).bind(stamp, stamp, id).run()
  }

  await audit(c.env.DB, {
    entityType: 'job', entityId: id, action: 'status_changed', actorId: u.id,
    previousValue: job.status, newValue: to, reason
  })
  await emitEvent(c.env.DB, 'job.status_changed', { job_id: id, from: job.status, to }, { actorId: u.id })

  return c.json({ id, status: to, message: `Requisition moved to ${to.replace(/_/g, ' ')}` })
})

/* --------------------------------------------- create application (job) */
api.post('/jobs/:id/applications', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'application.create')) return c.json({ error: 'forbidden' }, 403)
  const jobId = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))

  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<any>()
  if (!job) return c.json({ error: 'not_found', message: 'Requisition not found' }, 404)
  if (!['open', 'paused'].includes(job.status)) {
    return c.json({ error: 'job_not_open', message: `Applications require an Open requisition (current: ${job.status})` }, 422)
  }

  let candidateId = b.candidate_id ? Number(b.candidate_id) : 0
  let createdCandidate = false

  if (!candidateId) {
    const first_name = String(b.first_name || '').trim()
    const last_name = String(b.last_name || '').trim()
    const email = String(b.email || '').trim().toLowerCase()
    if (!first_name || !last_name || !email) {
      return c.json({ error: 'validation', message: 'Provide a candidate_id, or first name, last name and email' }, 400)
    }
    const existing = await c.env.DB.prepare('SELECT id FROM candidates WHERE lower(email) = ? AND status = ?').bind(email, 'active').first<any>()
    if (existing) {
      candidateId = existing.id
    } else {
      const ins = await c.env.DB.prepare(
        `INSERT INTO candidates (first_name,last_name,email,phone,source,status,consent_status,created_by,created_at,updated_at)
         VALUES (?,?,?,?,?, 'active','unknown',?,?,?)`
      ).bind(first_name, last_name, email, b.phone || null, b.source || null, u.id, nowIso(), nowIso()).run()
      candidateId = Number(ins.meta.last_row_id)
      createdCandidate = true
      await c.env.DB.prepare('INSERT INTO candidate_index (candidate_id, search_blob, updated_at) VALUES (?,?,?)')
        .bind(candidateId, `${first_name} ${last_name} ${email}`, nowIso()).run()
    }
  } else {
    const cand = await c.env.DB.prepare("SELECT id, status FROM candidates WHERE id = ?").bind(candidateId).first<any>()
    if (!cand) return c.json({ error: 'not_found', message: 'Candidate not found' }, 404)
    if (cand.status !== 'active') return c.json({ error: 'candidate_inactive', message: `Candidate is ${cand.status}; pick the canonical record` }, 422)
  }

  const dupeApp = await c.env.DB.prepare('SELECT id FROM applications WHERE candidate_id = ? AND job_id = ?')
    .bind(candidateId, jobId).first<any>()
  if (dupeApp) {
    return c.json({ error: 'duplicate_application', message: 'This candidate already has an application for this requisition', application_id: dupeApp.id }, 409)
  }

  const ins = await c.env.DB.prepare(
    `INSERT INTO applications (candidate_id,job_id,stage,status,source,recruiter_id,stage_entered_at,applied_at,created_at,updated_at)
     VALUES (?,?,'applied','active',?,?,?,?,?,?)`
  ).bind(candidateId, jobId, b.source || null, job.recruiter_id || u.id, nowIso(), nowIso(), nowIso(), nowIso()).run()
  const appId = Number(ins.meta.last_row_id)

  await c.env.DB.prepare(
    `INSERT INTO application_stage_history (application_id,from_stage,to_stage,from_status,to_status,actor_id,reason,created_at)
     VALUES (?,NULL,'applied',NULL,'active',?,?,?)`
  ).bind(appId, u.id, 'Application received', nowIso()).run()

  // resume → pipeline
  if (b.resume_text && String(b.resume_text).trim().length > 30) {
    const parsed = parseResume(String(b.resume_text))
    const r = await c.env.DB.prepare(
      `INSERT INTO resumes (candidate_id,filename,mime_type,size_bytes,raw_text,parsed_json,status,attempts,is_primary,created_by,created_at,updated_at)
       VALUES (?,?,'text/plain',?,?,'{}','uploaded',0,1,?,?,?)`
    ).bind(candidateId, `pasted-${candidateId}.txt`, String(b.resume_text).length, String(b.resume_text), u.id, nowIso(), nowIso()).run()
    const resumeId = Number(r.meta.last_row_id)
    await processResume(c.env.DB, resumeId)

    const cand = await c.env.DB.prepare('SELECT * FROM candidates WHERE id = ?').bind(candidateId).first<any>()
    const blob = buildSearchBlob(parsed, cand)
    await c.env.DB.prepare(
      `INSERT INTO candidate_index (candidate_id, search_blob, skills, titles, employers, education, locations, resume_text, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(candidate_id) DO UPDATE SET search_blob=excluded.search_blob, skills=excluded.skills,
         titles=excluded.titles, employers=excluded.employers, education=excluded.education,
         locations=excluded.locations, resume_text=excluded.resume_text, updated_at=excluded.updated_at`
    ).bind(
      candidateId, blob, parsed.skills.join(', '), parsed.titles.join(', '), parsed.employers.join(', '),
      parsed.education.join(', '), parsed.locations.join(', '), parsed.text.slice(0, 20000), nowIso()
    ).run()
  }

  await audit(c.env.DB, {
    entityType: 'application', entityId: appId, action: 'created', actorId: u.id,
    newValue: { candidate_id: candidateId, job_id: jobId, stage: 'applied' }
  })
  await emitEvent(c.env.DB, 'application.created', {
    application_id: appId, candidate_id: candidateId, job_id: jobId, job_title: job.title,
    recruiter_id: job.recruiter_id, hiring_manager_id: job.hiring_manager_id
  }, { eventKey: `application.created:${appId}`, actorId: u.id })

  return c.json({ id: appId, candidate_id: candidateId, created_candidate: createdCandidate, message: 'Application created' }, 201)
})

/* ------------------------------------------------------- applications */
api.post('/applications/:id/stage', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'application.move')) return c.json({ error: 'forbidden', message: 'You cannot move applications' }, 403)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  const to = String(b.to_stage || '')
  const reason = b.reason ? String(b.reason) : null

  const app = await c.env.DB.prepare(
    `SELECT a.*, j.title AS job_title, j.hiring_manager_id, j.status AS job_status FROM applications a
       JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`
  ).bind(id).first<any>()
  if (!app) return c.json({ error: 'not_found', message: 'Application not found' }, 404)

  if (u.role === 'hiring_manager' && app.hiring_manager_id !== u.id) {
    return c.json({ error: 'forbidden', message: 'This requisition is not assigned to you' }, 403)
  }
  if (['rejected', 'withdrawn'].includes(app.status)) {
    return c.json({ error: 'terminal', message: 'Application is in a terminal state' }, 422)
  }

  const guard = validateStageMove(app.stage, to)
  if (!guard.ok) return c.json({ error: guard.code, message: guard.message }, 422)
  if (guard.requiresReason && !reason) {
    return c.json({ error: 'reason_required', message: 'A reason is required for multi-stage moves and rewinds' }, 400)
  }

  // ATS-10 interview feedback enforcement
  if (stageIndex(to) > stageIndex('interview') && app.stage !== 'offer' && app.stage !== 'hired') {
    const outstanding = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM interview_participants p
        LEFT JOIN feedback f ON f.interview_id = p.interview_id AND f.interviewer_id = p.user_id AND f.status = 'submitted'
        JOIN interviews i ON i.id = p.interview_id
       WHERE i.application_id = ? AND f.id IS NULL`
    ).bind(id).first<any>()
    if (Number(outstanding?.n || 0) > 0) {
      const exception = await c.env.DB.prepare(
        `SELECT id FROM audit_events WHERE entity_type='application' AND entity_id=? AND action='feedback_exception'
          AND created_at > ?`
      ).bind(String(id), new Date(Date.now() - 86400000).toISOString()).first<any>()
      if (!exception) {
        return c.json({
          error: 'feedback_incomplete',
          message: `${outstanding.n} panel scorecard(s) outstanding. Feedback must be complete before advancing to ${to}, or record an authorised exception.`,
          outstanding: Number(outstanding.n)
        }, 422)
      }
    }
  }

  const stamp = nowIso()
  const patch: string[] = ['stage = ?', 'updated_at = ?', 'stage_entered_at = ?']
  const args: any[] = [to, stamp, stamp]

  if (to === 'recruiter_review' && !app.first_review_at) { patch.push('first_review_at = ?'); args.push(stamp) }

  await c.env.DB.prepare(`UPDATE applications SET ${patch.join(', ')} WHERE id = ?`).bind(...args, id).run()
  await c.env.DB.prepare(
    `INSERT INTO application_stage_history (application_id,from_stage,to_stage,from_status,to_status,actor_id,reason,created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, app.stage, to, app.status, app.status, u.id, reason, stamp).run()

  await audit(c.env.DB, {
    entityType: 'application', entityId: id, action: 'stage_changed', actorId: u.id,
    previousValue: app.stage, newValue: to, reason
  })
  await emitEvent(c.env.DB, 'application.stage_changed', {
    application_id: id, candidate_id: app.candidate_id, job_id: app.job_id, job_title: app.job_title,
    from_stage: app.stage, to_stage: to, hiring_manager_id: app.hiring_manager_id, assignee_id: app.hiring_manager_id
  }, { eventKey: `application.stage_changed:${id}:${to}:${hashString(stamp)}`, actorId: u.id })

  return c.json({ id, stage: to, message: `Moved to ${to.replace(/_/g, ' ')}` })
})

api.post('/applications/:id/status', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'application.move')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  const to = String(b.status || '')
  const reason = b.reason ? String(b.reason) : null

  if (!['active', 'on_hold', 'rejected', 'withdrawn', 'hired'].includes(to)) {
    return c.json({ error: 'validation', message: 'Unknown status' }, 400)
  }
  const app = await c.env.DB.prepare(
    `SELECT a.*, j.title AS job_title, j.hiring_manager_id, j.openings FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.id = ?`
  ).bind(id).first<any>()
  if (!app) return c.json({ error: 'not_found', message: 'Application not found' }, 404)
  if (['rejected', 'withdrawn'].includes(app.status) && to !== app.status) {
    return c.json({ error: 'terminal', message: 'Terminal applications cannot be reopened' }, 422)
  }
  if (['rejected'].includes(to) && !can(u.role, 'application.reject')) {
    return c.json({ error: 'forbidden', message: 'Your role cannot reject applications' }, 403)
  }
  if (['rejected', 'withdrawn', 'on_hold'].includes(to) && !reason) {
    return c.json({ error: 'reason_required', message: 'A reason is required for this status change' }, 400)
  }

  const stamp = nowIso()
  const closed = ['rejected', 'withdrawn', 'hired'].includes(to)
  await c.env.DB.prepare(
    `UPDATE applications SET status = ?, rejection_reason = ?, drop_off_reason = ?, closed_at = ?, updated_at = ?, decision_at = ?${to === 'hired' ? ", stage = 'hired', stage_entered_at = ?" : ''} WHERE id = ?`
  ).bind(
    to,
    to === 'rejected' ? reason : app.rejection_reason,
    to === 'withdrawn' ? reason : app.drop_off_reason,
    closed ? stamp : null,
    stamp,
    closed ? stamp : app.decision_at,
    ...(to === 'hired' ? [stamp] : []),
    id
  ).run()

  if (to === 'hired') {
    await c.env.DB.prepare(
      `INSERT INTO onboarding (application_id, status, tasks_json, start_date, created_at, updated_at)
       VALUES (?, 'not_started', ?, NULL, ?, ?)
       ON CONFLICT(application_id) DO NOTHING`
    ).bind(id, JSON.stringify([
      { key: 'contract', label: 'Sign employment contract', done: false },
      { key: 'id', label: 'Upload ID documents', done: false },
      { key: 'equipment', label: 'Select equipment', done: false },
      { key: 'orientation', label: 'Book orientation', done: false }
    ]), stamp, stamp).run()
  }

  await audit(c.env.DB, {
    entityType: 'application', entityId: id, action: to === 'rejected' ? 'rejected' : 'status_changed',
    actorId: u.id, previousValue: app.status, newValue: to, reason
  })
  await emitEvent(c.env.DB, to === 'rejected' ? 'application.rejected' : 'application.status_changed', {
    application_id: id, candidate_id: app.candidate_id, job_id: app.job_id, job_title: app.job_title,
    status: to, reason
  }, { eventKey: `application.${to}:${id}:${hashString(stamp)}`, actorId: u.id })

  return c.json({ id, status: to, message: `Application marked ${to.replace(/_/g, ' ')}` })
})

api.post('/applications/:id/review', requireAuth, async (c) => {
  const u = currentUser(c)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  const decision = String(b.decision || '')
  if (!['shortlist', 'reject', 'request_more_info'].includes(decision)) {
    return c.json({ error: 'validation', message: 'Unknown review decision' }, 400)
  }
  const app = await c.env.DB.prepare('SELECT * FROM applications WHERE id = ?').bind(id).first<any>()
  if (!app) return c.json({ error: 'not_found' }, 404)

  const note = b.note || b.reason || null
  if (note) {
    await c.env.DB.prepare(
      `INSERT INTO candidate_notes (candidate_id, application_id, author_id, body, visibility, created_at)
       VALUES (?,?,?,?, 'team', ?)`
    ).bind(app.candidate_id, id, u.id, `[${decision}] ${note}`, nowIso()).run()
  }
  await audit(c.env.DB, {
    entityType: 'application', entityId: id, action: `review_${decision}`, actorId: u.id, reason: note
  })
  return c.json({ id, decision, message: `Review recorded: ${decision.replace(/_/g, ' ')}` })
})

export default api
