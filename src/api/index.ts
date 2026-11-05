import { Hono } from 'hono'
import type { AppEnv } from '../lib/auth'
import { currentUser, requireAuth } from '../lib/auth'
import { can } from '../lib/rbac'
import { audit, emitEvent } from '../lib/audit'
import { nowIso, addDays, parseJson, hashString, pct, normEmail, normPhone, truncate } from '../lib/util'
import { searchCandidates } from '../lib/searchService'
import { detectDuplicates, mergePreview, executeMerge, revertMerge, refreshDuplicateQueue } from '../lib/dedupe'
import { parseResume, buildSearchBlob, processResume, retryResume, drainQueue } from '../lib/resume'
import { summarizeCandidate, compareCandidates, summarizeFeedback, interpretQuery, sourceInsights } from '../lib/ai'
import { loadAnalytics, METRIC_DEFS } from '../lib/metrics'
import { escalateOverdue, loadAging, loadWorkload, loadRequisitionAging } from '../lib/sla'
import { INTERVIEW_TRANSITIONS, OFFER_TRANSITIONS, ONBOARDING_TRANSITIONS, POSTING_TRANSITIONS, assertTransition } from '../lib/lifecycle'

export const api = new Hono<AppEnv>()

const csv = (rows: (string | number | null | undefined)[][]): string =>
  rows
    .map((r) =>
      r
        .map((v) => {
          const s = v === null || v === undefined ? '' : String(v)
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(',')
    )
    .join('\r\n')

/* ============================================================== candidates */
api.get('/candidates', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.search')) return c.json({ error: 'forbidden' }, 403)
  const q = c.req.query()
  const result = await searchCandidates(c.env.DB, {
    q: q.q,
    mode: (q.mode as any) || 'boolean',
    skills: q.skills,
    location: q.location,
    minExperience: q.minExperience ? Number(q.minExperience) : undefined,
    maxNotice: q.maxNotice ? Number(q.maxNotice) : undefined,
    maxSalary: q.maxSalary ? Number(q.maxSalary) : undefined,
    tags: q.tags,
    consent: q.consent,
    poolId: q.poolId ? Number(q.poolId) : undefined,
    appliedToJobId: q.appliedToJobId ? Number(q.appliedToJobId) : undefined,
    sort: q.sort,
    page: q.page ? Number(q.page) : 1,
    perPage: q.perPage ? Number(q.perPage) : 25
  }, u.id)
  return c.json(result)
})

api.get('/candidates/export.csv', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.export')) return c.json({ error: 'forbidden', message: 'You cannot export candidate data' }, 403)
  const q = c.req.query()
  const result = await searchCandidates(c.env.DB, {
    q: q.q, mode: (q.mode as any) || 'boolean', skills: q.skills, location: q.location,
    minExperience: q.minExperience ? Number(q.minExperience) : undefined,
    maxNotice: q.maxNotice ? Number(q.maxNotice) : undefined,
    maxSalary: q.maxSalary ? Number(q.maxSalary) : undefined,
    tags: q.tags, consent: q.consent,
    poolId: q.poolId ? Number(q.poolId) : undefined,
    appliedToJobId: q.appliedToJobId ? Number(q.appliedToJobId) : undefined,
    sort: q.sort, page: 1, perPage: 10000
  }, u.id, { audit: false })

  const rows: any[][] = [[
    'id', 'first_name', 'last_name', 'email', 'phone', 'location', 'headline', 'current_employer',
    'experience_years', 'notice_period_days', 'expected_salary', 'consent_status', 'source', 'applications', 'created_at'
  ]]
  for (const r of result.results) {
    rows.push([r.id, r.first_name, r.last_name, r.email, r.phone, r.location, r.headline, r.current_employer,
      r.experience_years, r.notice_period_days, r.expected_salary, r.consent_status, r.source,
      r.application_count, r.created_at])
  }
  await audit(c.env.DB, {
    entityType: 'candidate', entityId: 'export', action: 'exported', actorId: u.id,
    meta: { rows: result.results.length, query: q.q || null }
  })
  return new Response(csv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="candidates-${nowIso().slice(0, 10)}.csv"`
    }
  })
})

api.post('/candidates', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.create')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const first_name = String(b.first_name || '').trim()
  const last_name = String(b.last_name || '').trim()
  const email = String(b.email || '').trim().toLowerCase()
  if (!first_name || !last_name || !email) {
    return c.json({ error: 'validation', message: 'First name, last name and email are required' }, 400)
  }
  const existing = await c.env.DB.prepare('SELECT id FROM candidates WHERE lower(email) = ? AND status = ?')
    .bind(email, 'active').first<any>()
  if (existing) {
    return c.json({ error: 'duplicate_candidate', message: 'A candidate with this email already exists', candidate_id: existing.id }, 409)
  }
  const res = await c.env.DB.prepare(
    `INSERT INTO candidates (first_name,last_name,email,phone,location,headline,current_employer,education,
       experience_years,notice_period_days,expected_salary,summary,source,consent_status,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    first_name, last_name, email, b.phone || null, b.location || null, b.headline || null,
    b.current_employer || null, b.education || null, b.experience_years ? Number(b.experience_years) : null,
    b.notice_period_days ? Number(b.notice_period_days) : null,
    b.expected_salary ? Number(b.expected_salary) : null, b.summary || null, b.source || null,
    b.consent_status || 'unknown', u.id, nowIso(), nowIso()
  ).run()
  const id = Number(res.meta.last_row_id)
  await c.env.DB.prepare('INSERT INTO candidate_index (candidate_id, search_blob, updated_at) VALUES (?,?,?)')
    .bind(id, [first_name, last_name, email, b.location, b.headline, b.current_employer, b.education].filter(Boolean).join(' '), nowIso()).run()
  await c.env.DB.prepare('INSERT INTO candidate_consent (candidate_id, channel, status, source, updated_by, updated_at) VALUES (?,?,?,?,?,?)')
    .bind(id, 'email', b.consent_status || 'unknown', 'manual', u.id, nowIso()).run()
  await audit(c.env.DB, { entityType: 'candidate', entityId: id, action: 'created', actorId: u.id, newValue: { email } })
  return c.json({ id, message: 'Candidate created' }, 201)
})

api.patch('/candidates/:id', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.edit')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  const before = await c.env.DB.prepare('SELECT * FROM candidates WHERE id = ?').bind(id).first<any>()
  if (!before) return c.json({ error: 'not_found' }, 404)
  const b = await c.req.json<any>().catch(() => ({}))
  const allowed = ['first_name', 'last_name', 'email', 'phone', 'location', 'country', 'headline', 'current_employer',
    'education', 'experience_years', 'notice_period_days', 'current_salary', 'expected_salary', 'availability',
    'summary', 'linkedin', 'source', 'consent_status']
  const patch: Record<string, any> = {}
  for (const k of allowed) if (b[k] !== undefined) patch[k] = b[k] === '' ? null : b[k]
  if (!Object.keys(patch).length) return c.json({ error: 'validation', message: 'No fields to update' }, 400)

  if (patch.email) {
    const clash = await c.env.DB.prepare('SELECT id FROM candidates WHERE lower(email) = ? AND id != ? AND status = ?')
      .bind(String(patch.email).toLowerCase(), id, 'active').first<any>()
    if (clash) return c.json({ error: 'duplicate_email', message: 'Another active candidate uses this email', candidate_id: clash.id }, 409)
  }

  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ')
  await c.env.DB.prepare(`UPDATE candidates SET ${sets}, updated_at = ? WHERE id = ?`)
    .bind(...Object.values(patch), nowIso(), id).run()

  if (patch.consent_status) {
    await c.env.DB.prepare(
      `INSERT INTO candidate_consent (candidate_id, channel, status, source, updated_by, updated_at)
       VALUES (?, 'email', ?, 'profile_edit', ?, ?)
       ON CONFLICT(candidate_id, channel) DO UPDATE SET status = excluded.status, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).bind(id, patch.consent_status, u.id, nowIso()).run()
  }

  await audit(c.env.DB, {
    entityType: 'candidate', entityId: id, action: 'updated', actorId: u.id,
    previousValue: Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])), newValue: patch
  })
  return c.json({ id, message: 'Candidate updated' })
})

api.post('/candidates/:id/notes', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.edit')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  const body = String(b.body || '').trim()
  if (!body) return c.json({ error: 'validation', message: 'Note cannot be empty' }, 400)
  const res = await c.env.DB.prepare(
    'INSERT INTO candidate_notes (candidate_id, application_id, author_id, body, visibility, created_at) VALUES (?,?,?,?,?,?)'
  ).bind(id, b.application_id ? Number(b.application_id) : null, u.id, body, b.visibility || 'team', nowIso()).run()
  await audit(c.env.DB, { entityType: 'candidate', entityId: id, action: 'note_added', actorId: u.id })
  return c.json({ id: Number(res.meta.last_row_id), message: 'Note added' }, 201)
})

api.post('/candidates/:id/tags', requireAuth, async (c) => {
  const u = currentUser(c)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  if (!b.tag_id) return c.json({ error: 'validation', message: 'tag_id is required' }, 400)
  await c.env.DB.prepare('INSERT INTO candidate_tags (candidate_id, tag_id, tagged_by, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING')
    .bind(id, Number(b.tag_id), u.id, nowIso()).run()
  await audit(c.env.DB, { entityType: 'candidate', entityId: id, action: 'tagged', actorId: u.id, newValue: { tag_id: b.tag_id } })
  return c.json({ message: 'Tag applied' })
})

api.post('/candidates/:id/pools', requireAuth, async (c) => {
  const u = currentUser(c)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  if (!b.pool_id) return c.json({ error: 'validation', message: 'pool_id is required' }, 400)
  await c.env.DB.prepare(
    'INSERT INTO talent_pool_members (pool_id, candidate_id, added_by, source, created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING'
  ).bind(Number(b.pool_id), id, u.id, 'manual', nowIso()).run()
  await audit(c.env.DB, { entityType: 'candidate', entityId: id, action: 'added_to_pool', actorId: u.id, newValue: { pool_id: b.pool_id } })
  return c.json({ message: 'Added to pool' })
})

api.post('/candidates/:id/dsr', requireAuth, async (c) => {
  const u = currentUser(c)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  const type = String(b.type || 'export')
  if (!['export', 'delete', 'retention_review'].includes(type)) {
    return c.json({ error: 'validation', message: 'Unknown request type' }, 400)
  }
  if (type === 'delete' && !can(u.role, 'candidate.delete')) {
    return c.json({ error: 'forbidden', message: 'Only administrators can erase candidate records' }, 403)
  }

  const res = await c.env.DB.prepare(
    `INSERT INTO data_subject_requests (candidate_id, type, status, note, requested_by, created_at)
     VALUES (?,?, 'pending', ?, ?, ?)`
  ).bind(id, type, b.note || b.reason || null, u.id, nowIso()).run()
  const dsrId = Number(res.meta.last_row_id)

  if (type === 'delete') {
    // Anonymise rather than hard delete: preserves application/audit integrity
    const cand = await c.env.DB.prepare('SELECT * FROM candidates WHERE id = ?').bind(id).first<any>()
    if (!cand) return c.json({ error: 'not_found' }, 404)
    await c.env.DB.prepare(
      `UPDATE candidates SET first_name = 'Erased', last_name = ?, email = ?, phone = NULL,
         location = NULL, summary = NULL, headline = NULL, current_employer = NULL, education = NULL,
         linkedin = NULL, status = 'anonymized', consent_status = 'opt_out', updated_at = ? WHERE id = ?`
    ).bind(`Candidate ${id}`, `erased-${id}@redacted.invalid`, nowIso(), id).run()
    await c.env.DB.prepare('DELETE FROM candidate_index WHERE candidate_id = ?').bind(id).run()
    await c.env.DB.prepare("UPDATE messages SET body = '[redacted]', subject = '[redacted]' WHERE candidate_id = ?").bind(id).run()
    await c.env.DB.prepare("UPDATE resumes SET raw_text = NULL, parsed_json = '{}' WHERE candidate_id = ?").bind(id).run()
    await c.env.DB.prepare("UPDATE data_subject_requests SET status = 'completed', completed_by = ?, completed_at = ? WHERE id = ?")
      .bind(u.id, nowIso(), dsrId).run()
    await audit(c.env.DB, {
      entityType: 'candidate', entityId: id, action: 'erased', actorId: u.id,
      previousValue: { status: cand.status }, newValue: { status: 'anonymized' }, reason: b.reason || 'DSR delete'
    })
    return c.json({ id: dsrId, status: 'completed', message: 'Candidate personal data erased (record retained for audit integrity)' })
  }

  await audit(c.env.DB, { entityType: 'candidate', entityId: id, action: `dsr_${type}`, actorId: u.id })
  return c.json({ id: dsrId, status: 'pending', message: `Data subject request recorded: ${type}` }, 201)
})

api.get('/candidates/:id/export', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.export')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  const cand = await c.env.DB.prepare('SELECT * FROM candidates WHERE id = ?').bind(id).first<any>()
  if (!cand) return c.json({ error: 'not_found' }, 404)
  const apps = await c.env.DB.prepare(
    'SELECT a.*, j.title FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.candidate_id = ?'
  ).bind(id).all<any>()
  const notes = await c.env.DB.prepare('SELECT * FROM candidate_notes WHERE candidate_id = ?').bind(id).all<any>()
  const msgs = await c.env.DB.prepare('SELECT id, channel, subject, status, created_at FROM messages WHERE candidate_id = ?').bind(id).all<any>()
  const consents = await c.env.DB.prepare('SELECT * FROM candidate_consent WHERE candidate_id = ?').bind(id).all<any>()

  await audit(c.env.DB, { entityType: 'candidate', entityId: id, action: 'data_exported', actorId: u.id })
  return c.json({
    exported_at: nowIso(),
    candidate: cand,
    applications: apps.results,
    notes: notes.results,
    messages: msgs.results,
    consents: consents.results
  })
})

/* ------------------------------------------------------ duplicate merge */
api.get('/candidates/duplicates', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.*, p.first_name AS p_first, p.last_name AS p_last FROM duplicate_reviews d
       JOIN candidates p ON p.id = d.primary_id
      WHERE d.status = 'pending' ORDER BY d.score DESC`
  ).all<any>()
  return c.json({ pairs: results })
})

api.post('/candidates/duplicates/refresh', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.merge')) return c.json({ error: 'forbidden' }, 403)
  const added = await refreshDuplicateQueue(c.env.DB)
  await audit(c.env.DB, { entityType: 'candidate', entityId: 'duplicate_scan', action: 'scan_run', actorId: u.id, meta: { added } })
  return c.json({ added, message: `Duplicate scan complete — ${added} new pair(s)` })
})

api.post('/candidates/duplicates/:id/ignore', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.merge')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare("UPDATE duplicate_reviews SET status = 'ignored', decided_by = ?, decided_at = ? WHERE id = ?")
    .bind(u.id, nowIso(), id).run()
  await audit(c.env.DB, { entityType: 'candidate', entityId: id, action: 'duplicate_ignored', actorId: u.id })
  return c.json({ id, message: 'Marked as not a duplicate' })
})

api.post('/candidates/merge-preview', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.merge')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  try {
    const preview = await mergePreview(c.env.DB, Number(b.primary_id), Number(b.duplicate_id))
    return c.json(preview)
  } catch (e: any) {
    return c.json({ error: e.message, message: 'Could not build merge preview' }, 422)
  }
})

api.post('/candidates/merge', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.merge')) return c.json({ error: 'forbidden', message: 'You cannot merge candidates' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const primary = Number(b.primary_id)
  const duplicate = Number(b.duplicate_id)
  if (!primary || !duplicate) return c.json({ error: 'validation', message: 'primary_id and duplicate_id are required' }, 400)
  try {
    const out = await executeMerge(c.env.DB, primary, duplicate, u.id, b.reason)
    await emitEvent(c.env.DB, 'candidate.merged', { candidate_id: primary, merged_id: duplicate }, { eventKey: `candidate.merged:${primary}:${duplicate}`, actorId: u.id })
    return c.json({ ...out, message: `Merged #${duplicate} into #${primary}` })
  } catch (e: any) {
    const map: Record<string, string> = {
      cannot_merge_self: 'A candidate cannot be merged into itself',
      already_merged: 'That candidate has already been merged',
      candidate_not_found: 'One of the candidates no longer exists'
    }
    return c.json({ error: e.message, message: map[e.message] || 'Merge failed' }, 422)
  }
})

api.post('/merges/:id/revert', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.settings')) return c.json({ error: 'forbidden', message: 'Only administrators can revert merges' }, 403)
  try {
    const out = await revertMerge(c.env.DB, Number(c.req.param('id')), u.id)
    return c.json(out)
  } catch (e: any) {
    return c.json({ error: e.message, message: 'Revert failed' }, 422)
  }
})

/* ------------------------------------------------------- saved searches */
api.post('/saved-searches', requireAuth, async (c) => {
  const u = currentUser(c)
  const b = await c.req.json<any>().catch(() => ({}))
  const name = String(b.name || '').trim()
  const query = String(b.query || '').trim()
  if (!name || !query) return c.json({ error: 'validation', message: 'Name and query are required' }, 400)
  const res = await c.env.DB.prepare(
    'INSERT INTO saved_searches (owner_id, name, query, mode, filters, pool_id, shared, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(u.id, name, query, b.mode === 'semantic' ? 'semantic' : 'boolean', JSON.stringify(b.filters || {}), b.pool_id || null, b.shared ? 1 : 0, nowIso()).run()
  return c.json({ id: Number(res.meta.last_row_id), message: 'Search saved' }, 201)
})

api.delete('/saved-searches/:id', requireAuth, async (c) => {
  const u = currentUser(c)
  const id = Number(c.req.param('id'))
  const row = await c.env.DB.prepare('SELECT owner_id FROM saved_searches WHERE id = ?').bind(id).first<any>()
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (row.owner_id !== u.id && u.role !== 'admin') return c.json({ error: 'forbidden' }, 403)
  await c.env.DB.prepare('DELETE FROM saved_searches WHERE id = ?').bind(id).run()
  return c.json({ message: 'Saved search deleted' })
})

/* ============================================================ resumes */
api.post('/resumes/:id/retry', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.edit')) return c.json({ error: 'forbidden' }, 403)
  try {
    const out = await retryResume(c.env.DB, Number(c.req.param('id')))
    await audit(c.env.DB, { entityType: 'resume', entityId: c.req.param('id'), action: 'retried', actorId: u.id, meta: out })
    return c.json({ ...out, message: out.ok ? 'Resume reprocessed' : `Retry failed: ${out.error}` })
  } catch (e: any) {
    return c.json({ error: e.message, message: e.message === 'not_retryable' ? 'Only failed resumes can be retried' : 'Retry failed' }, 422)
  }
})

api.post('/resumes/drain', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.settings')) return c.json({ error: 'forbidden' }, 403)
  const out = await drainQueue(c.env.DB, 20)
  await audit(c.env.DB, { entityType: 'resume', entityId: 'queue', action: 'drained', actorId: u.id, meta: { processed: out.length } })
  return c.json({ processed: out.length, results: out, message: `Processed ${out.length} resume job(s)` })
})

api.get('/resumes/queue', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.candidate_id, r.filename, r.status, r.attempts, r.last_error, r.updated_at,
            c.first_name, c.last_name
       FROM resumes r JOIN candidates c ON c.id = r.candidate_id
      WHERE r.status != 'screening_ready'
      ORDER BY r.updated_at DESC LIMIT 100`
  ).all<any>()
  return c.json({ queue: results })
})

/* ========================================================= interviews */
api.post('/interviews', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'interview.schedule')) return c.json({ error: 'forbidden', message: 'You cannot schedule interviews' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const applicationId = Number(b.application_id)
  if (!applicationId) return c.json({ error: 'validation', message: 'application_id is required' }, 400)
  if (!b.scheduled_at) return c.json({ error: 'validation', message: 'scheduled_at is required' }, 400)

  const app = await c.env.DB.prepare(
    `SELECT a.*, j.title AS job_title, j.id AS job_id FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.id = ?`
  ).bind(applicationId).first<any>()
  if (!app) return c.json({ error: 'not_found', message: 'Application not found' }, 404)
  if (['rejected', 'withdrawn'].includes(app.status)) {
    return c.json({ error: 'terminal', message: 'Cannot interview a rejected or withdrawn application' }, 422)
  }

  // Pick a matching scorecard template for the job
  const tpl = await c.env.DB.prepare(
    'SELECT id FROM scorecard_templates WHERE job_id = ? ORDER BY required DESC, id LIMIT 1'
  ).bind(app.job_id).first<any>()
  const fallback = tpl || (await c.env.DB.prepare('SELECT id FROM scorecard_templates ORDER BY id LIMIT 1').first<any>())

  const scheduledAt = String(b.scheduled_at)
  const dueAt = new Date(new Date(scheduledAt).getTime() + 48 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')

  const res = await c.env.DB.prepare(
    `INSERT INTO interviews (application_id, round, title, mode, scheduled_at, duration_min, location, meeting_link,
       status, feedback_due_at, scorecard_template_id, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?, 'scheduled', ?, ?, ?, ?, ?)`
  ).bind(
    applicationId, b.round ? Number(b.round) : 1, b.title || 'Interview', b.mode || 'video',
    scheduledAt, b.duration_min ? Number(b.duration_min) : 45, b.location || null, b.meeting_link || null,
    dueAt, fallback?.id || null, u.id, nowIso(), nowIso()
  ).run()
  const interviewId = Number(res.meta.last_row_id)

  const panel: number[] = Array.isArray(b.interviewers)
    ? b.interviewers.map(Number).filter(Boolean)
    : b.interviewers ? [Number(b.interviewers)] : [u.id]
  for (const uid of [...new Set(panel)]) {
    await c.env.DB.prepare('INSERT INTO interview_participants (interview_id, user_id, role) VALUES (?,?,?) ON CONFLICT DO NOTHING')
      .bind(interviewId, uid, uid === panel[0] ? 'lead' : 'interviewer').run()
  }

  await audit(c.env.DB, {
    entityType: 'interview', entityId: interviewId, action: 'scheduled', actorId: u.id,
    newValue: { application_id: applicationId, scheduled_at: scheduledAt, panel }
  })
  await emitEvent(c.env.DB, 'interview.scheduled', {
    interview_id: interviewId, application_id: applicationId, candidate_id: app.candidate_id,
    job_id: app.job_id, job_title: app.job_title, scheduled_at: scheduledAt
  }, { eventKey: `interview.scheduled:${interviewId}`, actorId: u.id })

  return c.json({ id: interviewId, message: 'Interview scheduled' }, 201)
})

api.post('/interviews/:id/status', requireAuth, async (c) => {
  const u = currentUser(c)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  const to = String(b.to || '')
  const iv = await c.env.DB.prepare(
    `SELECT i.*, a.candidate_id, a.job_id, a.id AS app_id, j.title AS job_title FROM interviews i
       JOIN applications a ON a.id = i.application_id JOIN jobs j ON j.id = a.job_id WHERE i.id = ?`
  ).bind(id).first<any>()
  if (!iv) return c.json({ error: 'not_found' }, 404)

  const last = await c.env.DB.prepare(
    `SELECT i.round, i.title FROM interviews i
      WHERE i.application_id = ? AND i.id != ? ORDER BY i.round DESC LIMIT 1`
  ).bind(iv.application_id, id).first<any>()

  const reschedule = to === 'scheduled' && ['scheduled', 'confirmed'].includes(iv.status)
  if (!reschedule) {
    const guard = assertTransition(INTERVIEW_TRANSITIONS, iv.status, to)
    if (!guard.ok) return c.json({ error: 'invalid_transition', message: guard.message }, 422)
  } else if (!b.scheduled_at) {
    return c.json({ error: 'validation', message: 'scheduled_at is required to reschedule' }, 400)
  }
  if (to === 'cancelled' && !b.reason) {
    return c.json({ error: 'reason_required', message: 'A cancellation reason is required' }, 400)
  }

  const stamp = nowIso()
  const patch: string[] = ['status = ?', 'updated_at = ?']
  const args: any[] = [to, stamp]
  if (to === 'completed') { patch.push('completed_at = ?'); args.push(stamp) }
  if (to === 'cancelled') { patch.push('cancelled_reason = ?'); args.push(b.reason) }
  if (reschedule) { patch.push('scheduled_at = ?'); args.push(String(b.scheduled_at)) }
  if (['scheduled', 'confirmed', 'cancelled'].includes(to) && iv.status !== 'draft') {
    patch.push('feedback_due_at = ?')
    args.push(new Date(Date.now() + 48 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'))
  }

  await c.env.DB.prepare(`UPDATE interviews SET ${patch.join(', ')} WHERE id = ?`).bind(...args, id).run()

  // auto feedback_pending when all panel members submitted
  if (to === 'completed') {
    const outs = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM interview_participants p
        LEFT JOIN feedback f ON f.interview_id = p.interview_id AND f.interviewer_id = p.user_id AND f.status='submitted'
       WHERE p.interview_id = ? AND f.id IS NULL`
    ).bind(id).first<any>()
    if (Number(outs?.n || 0) > 0) {
      await c.env.DB.prepare("UPDATE interviews SET status = 'feedback_pending' WHERE id = ?").bind(id).run()
    }
    await emitEvent(c.env.DB, 'interview.completed', {
      interview_id: id, application_id: iv.application_id, candidate_id: iv.candidate_id,
      job_id: iv.job_id, job_title: iv.job_title, assignee_id: u.id
    }, { eventKey: `interview.completed:${id}`, actorId: u.id })
  }

  await audit(c.env.DB, {
    entityType: 'interview', entityId: id, action: reschedule ? 'rescheduled' : 'status_changed',
    actorId: u.id, previousValue: iv.status, newValue: to, reason: b.reason || null,
    meta: reschedule ? { from: iv.scheduled_at, to: b.scheduled_at, previous_round: last?.round } : undefined
  })
  return c.json({ id, status: to, message: reschedule ? 'Interview rescheduled' : `Interview ${to.replace(/_/g, ' ')}` })
})

api.post('/interviews/:id/feedback', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'interview.feedback.submit')) return c.json({ error: 'forbidden', message: 'You cannot submit interview feedback' }, 403)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))

  const iv = await c.env.DB.prepare(
    `SELECT i.*, st.criteria FROM interviews i LEFT JOIN scorecard_templates st ON st.id = i.scorecard_template_id WHERE i.id = ?`
  ).bind(id).first<any>()
  if (!iv) return c.json({ error: 'not_found' }, 404)

  const onPanel = await c.env.DB.prepare('SELECT 1 AS ok FROM interview_participants WHERE interview_id = ? AND user_id = ?')
    .bind(id, u.id).first<any>()
  if (!onPanel) return c.json({ error: 'forbidden', message: 'You are not on this interview panel' }, 403)
  if (!['scheduled', 'confirmed', 'completed', 'feedback_pending', 'feedback_complete', 'decision'].includes(iv.status)) {
    return c.json({ error: 'not_completed', message: 'Feedback can only be submitted after the interview is completed' }, 422)
  }

  // Build score array from score_<key> / note_<key> pairs
  const criteriaDefs = parseJson<any[]>(iv.criteria, [])
  const scores: any[] = []
  for (const key of Object.keys(b)) {
    if (!key.startsWith('score_')) continue
    const critKey = key.slice(6)
    const def = criteriaDefs.find((d) => d.key === critKey) || { key: critKey, label: critKey }
    const score = Number(b[key])
    if (!Number.isFinite(score)) continue
    scores.push({ criterion: critKey, label: def.label, score, note: b[`note_${critKey}`] || null })
  }
  if (!scores.length && b.overall === undefined) {
    return c.json({ error: 'validation', message: 'At least one criterion score is required' }, 400)
  }
  const overall = b.overall !== undefined ? Number(b.overall) : Math.round(scores.reduce((s, x) => s + x.score, 0) / (scores.length || 1))
  if (!Number.isFinite(overall) || overall < 1 || overall > 5) {
    return c.json({ error: 'validation', message: 'Overall rating must be between 1 and 5' }, 400)
  }
  if (!b.recommendation) return c.json({ error: 'validation', message: 'A recommendation is required' }, 400)
  if (!b.evidence || String(b.evidence).trim().length < 20) {
    return c.json({ error: 'evidence_required', message: 'Evidence is required (at least 20 characters) — scorecards without evidence are flagged' }, 400)
  }

  const existing = await c.env.DB.prepare('SELECT * FROM feedback WHERE interview_id = ? AND interviewer_id = ?')
    .bind(id, u.id).first<any>()

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE feedback SET scores_json = ?, overall = ?, recommendation = ?, evidence = ?, status = 'submitted',
         version = version + 1, submitted_at = ?, updated_at = ? WHERE id = ?`
    ).bind(JSON.stringify(scores), overall, b.recommendation, b.evidence, nowIso(), nowIso(), existing.id).run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO feedback (interview_id, interviewer_id, scores_json, overall, recommendation, evidence, status, version, submitted_at, updated_at)
       VALUES (?,?,?,?,?,?, 'submitted', 1, ?, ?)`
    ).bind(id, u.id, JSON.stringify(scores), overall, b.recommendation, b.evidence, nowIso(), nowIso()).run()
  }

  // progress interview status
  const outs = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM interview_participants p
      LEFT JOIN feedback f ON f.interview_id = p.interview_id AND f.interviewer_id = p.user_id AND f.status='submitted'
     WHERE p.interview_id = ? AND f.id IS NULL`
  ).bind(id).first<any>()
  if (Number(outs?.n || 0) === 0) {
    await c.env.DB.prepare("UPDATE interviews SET status = 'feedback_complete', updated_at = ? WHERE id = ?").bind(nowIso(), id).run()
  } else if (iv.status === 'completed') {
    await c.env.DB.prepare("UPDATE interviews SET status = 'feedback_pending', updated_at = ? WHERE id = ?").bind(nowIso(), id).run()
  }

  await audit(c.env.DB, {
    entityType: 'interview', entityId: id, action: existing ? 'feedback_updated' : 'feedback_submitted',
    actorId: u.id, newValue: { overall, recommendation: b.recommendation, criteria: scores.length }, previousValue: existing ? { overall: existing.overall } : null
  })
  return c.json({ id, overall, message: `Feedback recorded (${overall}/5)` })
})

api.post('/interviews/:id/exception', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'offer.create')) return c.json({ error: 'forbidden', message: 'Your role cannot authorise feedback exceptions' }, 403)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  if (!b.reason || String(b.reason).trim().length < 10) {
    return c.json({ error: 'reason_required', message: 'A written reason (10+ characters) is required for an exception' }, 400)
  }
  const iv = await c.env.DB.prepare('SELECT application_id FROM interviews WHERE id = ?').bind(id).first<any>()
  if (!iv) return c.json({ error: 'not_found' }, 404)
  await audit(c.env.DB, {
    entityType: 'application', entityId: iv.application_id, action: 'feedback_exception',
    actorId: u.id, reason: String(b.reason), meta: { interview_id: id }
  })
  return c.json({ message: 'Exception recorded — decision gate unlocked for 24 hours' })
})

api.get('/interviews/:id/summary', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  const iv = await c.env.DB.prepare('SELECT application_id FROM interviews WHERE id = ?').bind(id).first<any>()
  if (!iv) return c.json({ error: 'not_found' }, 404)
  const summary = await summarizeFeedback(c.env.DB, iv.application_id)
  return c.json(summary)
})

/* ============================================================== offers */
api.post('/offers', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'offer.create')) return c.json({ error: 'forbidden', message: 'You cannot create offers' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const applicationId = Number(b.application_id)
  if (!applicationId) return c.json({ error: 'validation', message: 'application_id is required' }, 400)

  const app = await c.env.DB.prepare(
    `SELECT a.*, j.title AS job_title, j.openings FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.id = ?`
  ).bind(applicationId).first<any>()
  if (!app) return c.json({ error: 'not_found', message: 'Application not found' }, 404)

  // ATS-10 enforcement: feedback must be complete before an offer
  const outstanding = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM interview_participants p
       LEFT JOIN feedback f ON f.interview_id = p.interview_id AND f.interviewer_id = p.user_id AND f.status='submitted'
       JOIN interviews i ON i.id = p.interview_id
      WHERE i.application_id = ? AND f.id IS NULL`
  ).bind(applicationId).first<any>()
  if (Number(outstanding?.n || 0) > 0) {
    const exception = await c.env.DB.prepare(
      `SELECT id FROM audit_events WHERE entity_type='application' AND entity_id=? AND action='feedback_exception' AND created_at > ?`
    ).bind(String(applicationId), new Date(Date.now() - 86400000).toISOString()).first<any>()
    if (!exception) {
      return c.json({
        error: 'feedback_incomplete',
        message: `${outstanding.n} scorecard(s) outstanding — feedback must be complete before an offer is raised, or record an authorised exception.`,
        outstanding: Number(outstanding.n)
      }, 422)
    }
  }

  const res = await c.env.DB.prepare(
    `INSERT INTO offers (application_id, version, status, base_salary, bonus, equity, currency, start_date,
       expires_at, notes, created_by, created_at, updated_at)
     VALUES (?,?, 'draft', ?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    applicationId, 1, b.base_salary ? Number(b.base_salary) : null, b.bonus ? Number(b.bonus) : null,
    b.equity || null, b.currency || 'USD', b.start_date || null, b.expires_at || null,
    b.notes || null, u.id, nowIso(), nowIso()
  ).run()
  const id = Number(res.meta.last_row_id)

  await audit(c.env.DB, { entityType: 'offer', entityId: id, action: 'created', actorId: u.id, newValue: { application_id: applicationId, version: 1 } })
  return c.json({ id, message: 'Offer created in Draft' }, 201)
})

api.post('/offers/:id/status', requireAuth, async (c) => {
  const u = currentUser(c)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  const to = String(b.to || '')
  const offer = await c.env.DB.prepare(
    `SELECT o.*, a.id AS app_id, a.candidate_id, a.job_id, j.title AS job_title FROM offers o
       JOIN applications a ON a.id = o.application_id JOIN jobs j ON j.id = a.job_id WHERE o.id = ?`
  ).bind(id).first<any>()
  if (!offer) return c.json({ error: 'not_found' }, 404)

  const transition = (OFFER_TRANSITIONS[offer.status] || []).find((t) => t.to === to)
  if (!transition) {
    return c.json({ error: 'invalid_transition', message: `Cannot move a ${offer.status} offer to ${to}. Allowed: ${(OFFER_TRANSITIONS[offer.status] || []).map((t) => t.to).join(', ') || 'none'}` }, 422)
  }
  if (!can(u.role, transition.perm)) return c.json({ error: 'forbidden', message: `Your role cannot ${transition.label.toLowerCase()}` }, 403)

  const stamp = nowIso()
  const patch: string[] = ['status = ?', 'updated_at = ?']
  const args: any[] = [to, stamp]
  if (to === 'approved') { patch.push('approved_by = ?', 'approved_at = ?', 'approval_note = ?'); args.push(u.id, stamp, b.reason || null) }
  if (to === 'released') { patch.push('released_at = ?'); args.push(stamp) }
  if (['accepted', 'declined', 'expired'].includes(to)) { patch.push('responded_at = ?', 'response_note = ?'); args.push(stamp, b.reason || null) }

  await c.env.DB.prepare(`UPDATE offers SET ${patch.join(', ')} WHERE id = ?`).bind(...args, id).run()

  // cascade application state
  if (to === 'accepted') {
    await c.env.DB.prepare(
      `UPDATE applications SET status = 'hired', stage = 'hired', stage_entered_at = ?, decision_at = ?, closed_at = ?, updated_at = ? WHERE id = ?`
    ).bind(stamp, stamp, stamp, stamp, offer.app_id).run()
    await c.env.DB.prepare(
      `INSERT INTO application_stage_history (application_id, from_stage, to_stage, from_status, to_status, actor_id, reason, created_at)
       VALUES (?, 'offer', 'hired', 'active', 'hired', ?, ?, ?)`
    ).bind(offer.app_id, u.id, 'Offer accepted', stamp).run()
    await c.env.DB.prepare(
      `INSERT INTO onboarding (application_id, status, tasks_json, start_date, created_at, updated_at)
       VALUES (?, 'not_started', ?, ?, ?, ?) ON CONFLICT(application_id) DO NOTHING`
    ).bind(offer.app_id, JSON.stringify([
      { key: 'contract', label: 'Sign employment contract', done: false },
      { key: 'id', label: 'Upload ID documents', done: false },
      { key: 'equipment', label: 'Select equipment', done: false },
      { key: 'orientation', label: 'Book orientation', done: false }
    ]), offer.start_date || null, stamp, stamp).run()
  }
  if (to === 'declined') {
    await c.env.DB.prepare(
      `UPDATE applications SET status = 'rejected', drop_off_reason = ?, closed_at = ?, decision_at = ?, updated_at = ? WHERE id = ?`
    ).bind('Offer declined', stamp, stamp, stamp, offer.app_id).run()
  }

  await audit(c.env.DB, {
    entityType: 'offer', entityId: id, action: 'status_changed', actorId: u.id,
    previousValue: offer.status, newValue: to, reason: b.reason || null
  })
  if (to === 'released') {
    await emitEvent(c.env.DB, 'offer.released', {
      offer_id: id, application_id: offer.app_id, candidate_id: offer.candidate_id,
      job_id: offer.job_id, job_title: offer.job_title
    }, { eventKey: `offer.released:${id}`, actorId: u.id })
  }

  return c.json({ id, status: to, message: `Offer ${to.replace(/_/g, ' ')}` })
})

api.post('/offers/:id/revise', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'offer.create')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  const offer = await c.env.DB.prepare('SELECT * FROM offers WHERE id = ?').bind(id).first<any>()
  if (!offer) return c.json({ error: 'not_found' }, 404)

  const maxV = await c.env.DB.prepare('SELECT MAX(version) AS v FROM offers WHERE application_id = ?')
    .bind(offer.application_id).first<any>()

  const res = await c.env.DB.prepare(
    `INSERT INTO offers (application_id, version, status, base_salary, bonus, equity, currency, start_date, expires_at, notes, created_by, created_at, updated_at)
     VALUES (?,?, 'draft', ?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    offer.application_id, Number(maxV?.v || 1) + 1,
    b.base_salary ? Number(b.base_salary) : offer.base_salary,
    b.bonus ? Number(b.bonus) : offer.bonus,
    b.equity || offer.equity, offer.currency,
    b.start_date || offer.start_date, b.expires_at || offer.expires_at,
    b.notes || offer.notes, u.id, nowIso(), nowIso()
  ).run()
  const newId = Number(res.meta.last_row_id)
  await audit(c.env.DB, {
    entityType: 'offer', entityId: newId, action: 'revision_created', actorId: u.id,
    meta: { from_version: offer.version, from_offer: id }
  })
  return c.json({ id: newId, version: Number(maxV?.v || 1) + 1, message: 'New offer version created' }, 201)
})

/* ========================================================== onboarding */
api.post('/onboarding/:id/status', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'onboarding.manage')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  const to = String(b.to || '')
  const row = await c.env.DB.prepare('SELECT * FROM onboarding WHERE id = ?').bind(id).first<any>()
  if (!row) return c.json({ error: 'not_found' }, 404)

  const guard = assertTransition(ONBOARDING_TRANSITIONS, row.status, to)
  if (!guard.ok) return c.json({ error: 'invalid_transition', message: guard.message }, 422)

  const stamp = nowIso()
  const patch: string[] = ['status = ?', 'updated_at = ?']
  const args: any[] = [to, stamp]
  if (to === 'initiated') { patch.push('initiated_at = ?'); args.push(stamp) }
  if (to === 'ready_to_join') { patch.push('ready_at = ?'); args.push(stamp) }
  if (to === 'joined') { patch.push('joined_at = ?'); args.push(stamp) }

  await c.env.DB.prepare(`UPDATE onboarding SET ${patch.join(', ')} WHERE id = ?`).bind(...args, id).run()
  await audit(c.env.DB, { entityType: 'onboarding', entityId: id, action: 'status_changed', actorId: u.id, previousValue: row.status, newValue: to })
  return c.json({ id, status: to, message: `Onboarding ${to.replace(/_/g, ' ')}` })
})

api.post('/onboarding/:id/tasks', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'onboarding.manage')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  const row = await c.env.DB.prepare('SELECT * FROM onboarding WHERE id = ?').bind(id).first<any>()
  if (!row) return c.json({ error: 'not_found' }, 404)
  const tasks = parseJson<any[]>(row.tasks_json, []).map((t) =>
    t.key === b.key ? { ...t, done: !!b.done } : t
  )
  await c.env.DB.prepare('UPDATE onboarding SET tasks_json = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(tasks), nowIso(), id).run()
  return c.json({ id, tasks, message: 'Task updated' })
})

/* =============================================================== pools */
api.post('/pools', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'pool.manage')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const name = String(b.name || '').trim()
  if (!name) return c.json({ error: 'validation', message: 'Pool name is required' }, 400)
  const res = await c.env.DB.prepare(
    'INSERT INTO talent_pools (name, description, kind, owner_id, visibility, created_at) VALUES (?,?,?,?,?,?)'
  ).bind(name, b.description || null, b.kind === 'folder' ? 'folder' : 'pool', u.id, b.visibility === 'private' ? 'private' : 'team', nowIso()).run()
  await audit(c.env.DB, { entityType: 'pool', entityId: Number(res.meta.last_row_id), action: 'created', actorId: u.id })
  return c.json({ id: Number(res.meta.last_row_id), message: 'Pool created' }, 201)
})

api.patch('/pools/:poolId/members/:candidateId', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'pool.manage')) return c.json({ error: 'forbidden' }, 403)
  const poolId = Number(c.req.param('poolId'))
  const candidateId = Number(c.req.param('candidateId'))
  const b = await c.req.json<any>().catch(() => ({}))
  if (!['not_contacted', 'contacted', 'interested', 'not_interested', 'hired'].includes(b.re_engagement)) {
    return c.json({ error: 'validation', message: 'Unknown re-engagement status' }, 400)
  }
  const res = await c.env.DB.prepare(
    'UPDATE talent_pool_members SET re_engagement = ? WHERE pool_id = ? AND candidate_id = ?'
  ).bind(b.re_engagement, poolId, candidateId).run()
  if (!res.meta.changes) return c.json({ error: 'not_found', message: 'Member not in pool' }, 404)
  await audit(c.env.DB, { entityType: 'pool', entityId: poolId, action: 'member_updated', actorId: u.id, newValue: { candidateId, re_engagement: b.re_engagement } })
  return c.json({ message: 'Re-engagement status updated' })
})

api.delete('/pools/:poolId/members/:candidateId', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'pool.manage')) return c.json({ error: 'forbidden' }, 403)
  await c.env.DB.prepare('DELETE FROM talent_pool_members WHERE pool_id = ? AND candidate_id = ?')
    .bind(Number(c.req.param('poolId')), Number(c.req.param('candidateId'))).run()
  return c.json({ message: 'Member removed from pool' })
})

api.post('/pools/reengage', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'message.send')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const poolId = Number(b.pool_id)
  if (!poolId) return c.json({ error: 'validation', message: 'pool_id is required' }, 400)

  const { results: members } = await c.env.DB.prepare(
    `SELECT m.candidate_id, c.first_name, c.email, c.consent_status FROM talent_pool_members m
       JOIN candidates c ON c.id = m.candidate_id
      WHERE m.pool_id = ? AND c.consent_status != 'opt_out' AND c.status = 'active'`
  ).bind(poolId).all<any>()

  let sent = 0, skipped = 0
  for (const m of members) {
    if (!m.email || m.consent_status === 'opt_out') { skipped++; continue }
    await c.env.DB.prepare(
      `INSERT INTO messages (candidate_id, template_id, batch_id, channel, to_address, subject, body, status, provider, sent_at, created_by, created_at)
       VALUES (?,?,?, 'email', ?, ?, ?, 'sent', 'internal-sim', ?, ?, ?)`
    ).bind(
      m.candidate_id, b.template_id || null, `reengage-${poolId}-${Date.now()}`,
      m.email, 'Still interested in a role at VSolutions?',
      `Hi ${m.first_name}, we are hiring again and think your profile could be a strong fit. Would you be open to a conversation?`,
      nowIso(), u.id, nowIso()
    ).run()
    await c.env.DB.prepare(
      "UPDATE talent_pool_members SET re_engagement = 'contacted', last_contact_at = ? WHERE pool_id = ? AND candidate_id = ?"
    ).bind(nowIso(), poolId, m.candidate_id).run()
    sent++
  }
  await audit(c.env.DB, { entityType: 'pool', entityId: poolId, action: 'reengaged', actorId: u.id, meta: { sent, skipped } })
  return c.json({ sent, skipped, message: `Re-engagement sent to ${sent} candidate(s), ${skipped} skipped (consent/no email)` })
})

/* ============================================================ messages */
api.post('/messages', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'message.send')) return c.json({ error: 'forbidden', message: 'You cannot send candidate messages' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const candidateId = Number(b.candidate_id)
  if (!candidateId) return c.json({ error: 'validation', message: 'candidate_id is required' }, 400)

  const cand = await c.env.DB.prepare('SELECT * FROM candidates WHERE id = ?').bind(candidateId).first<any>()
  if (!cand) return c.json({ error: 'not_found', message: 'Candidate not found' }, 404)
  if (cand.consent_status === 'opt_out') {
    await audit(c.env.DB, { entityType: 'candidate', entityId: candidateId, action: 'message_blocked', actorId: u.id, reason: 'opted out' })
    return c.json({ error: 'opted_out', message: 'Candidate has opted out of communications — send blocked' }, 422)
  }

  const tpl = b.template_id
    ? await c.env.DB.prepare('SELECT * FROM message_templates WHERE id = ?').bind(Number(b.template_id)).first<any>()
    : null
  const jobRow = b.application_id
    ? await c.env.DB.prepare('SELECT j.title FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.id = ?')
      .bind(Number(b.application_id)).first<any>()
    : null
  const fill = (s: string) =>
    String(s || '')
      .replace(/\{\{first_name\}\}/g, cand.first_name)
      .replace(/\{\{job_title\}\}/g, jobRow?.title || 'the role')

  const subject = fill(b.subject || tpl?.subject || 'Update on your application')
  const body = fill(b.body || tpl?.body || '')
  if (!body.trim()) return c.json({ error: 'validation', message: 'Message body is required' }, 400)

  const res = await c.env.DB.prepare(
    `INSERT INTO messages (candidate_id, application_id, template_id, channel, to_address, subject, body, status, provider, provider_message_id, sent_at, created_by, created_at)
     VALUES (?,?,?,?,?,?,?, 'sent', 'internal-sim', ?, ?, ?, ?)`
  ).bind(
    candidateId, b.application_id ? Number(b.application_id) : null, b.template_id ? Number(b.template_id) : null,
    b.channel || 'email', cand.email, subject, body,
    `sim-${hashString(candidateId + nowIso()).slice(0, 10)}`, nowIso(), u.id, nowIso()
  ).run()

  const id = Number(res.meta.last_row_id)
  await c.env.DB.prepare('INSERT INTO message_events (message_id, type, detail, created_at) VALUES (?,?,?,?)')
    .bind(id, 'sent', 'Delivered to simulated provider', nowIso()).run()
  await audit(c.env.DB, { entityType: 'message', entityId: id, action: 'sent', actorId: u.id, newValue: { candidate_id: candidateId, subject } })
  return c.json({ id, message: 'Message sent' }, 201)
})

api.get('/messages', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.*, c.first_name, c.last_name FROM messages m JOIN candidates c ON c.id=m.candidate_id ORDER BY m.id DESC LIMIT 100`
  ).all<any>()
  return c.json({ messages: results })
})

/* ============================================================ postings */
api.post('/postings/:id/publish', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'distribution.manage')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  const posting = await c.env.DB.prepare(
    `SELECT p.*, ch.api_supported, ch.name AS channel_name, j.status AS job_status, j.title AS job_title, j.code AS job_code
       FROM job_postings p JOIN channels ch ON ch.id = p.channel_id JOIN jobs j ON j.id = p.job_id WHERE p.id = ?`
  ).bind(id).first<any>()
  if (!posting) return c.json({ error: 'not_found' }, 404)

  if (!['open', 'paused'].includes(posting.job_status)) {
    return c.json({ error: 'job_not_open', message: `Only Open requisitions can be published (current: ${posting.job_status})` }, 422)
  }
  if (!['draft', 'failed', 'expired', 'withdrawn', 'queued'].includes(posting.status)) {
    return c.json({ error: 'invalid_transition', message: `Cannot publish a posting in ${posting.status} state` }, 422)
  }

  const stamp = nowIso()
  const attempts = posting.attempts + 1

  if (!posting.api_supported) {
    await c.env.DB.prepare(
      `UPDATE job_postings SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`
    ).bind(attempts, `${posting.channel_name} does not expose a supported publishing API — use manual export.`, stamp, id).run()
    await c.env.DB.prepare('INSERT INTO job_posting_events (posting_id, action, status, detail, actor_id, created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, 'publish', 'failed', 'No supported partner API for this channel', u.id, stamp).run()
    await audit(c.env.DB, { entityType: 'posting', entityId: id, action: 'publish_failed', actorId: u.id, reason: 'unsupported_channel' })
    return c.json({
      error: 'unsupported_channel',
      message: `${posting.channel_name} has no supported publishing API. The posting is marked failed — export the job description manually instead.`
    }, 422)
  }

  const externalId = `ext-${posting.job_id}-${posting.channel_id}-${hashString(stamp).slice(0, 6)}`
  const expires = new Date(Date.now() + 30 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await c.env.DB.prepare(
    `UPDATE job_postings SET status = 'published', external_id = ?, external_url = ?, attempts = ?,
       last_error = NULL, posted_at = ?, expires_at = ?, withdrawn_at = NULL, updated_at = ? WHERE id = ?`
  ).bind(externalId, `https://jobs.example.com/${String(posting.job_code).toLowerCase()}-${posting.channel_id}`, attempts, stamp, expires, stamp, id).run()
  await c.env.DB.prepare('INSERT INTO job_posting_events (posting_id, action, status, detail, actor_id, created_at) VALUES (?,?,?,?,?,?)')
    .bind(id, 'publish', 'published', `External ID ${externalId}`, u.id, stamp).run()
  await audit(c.env.DB, { entityType: 'posting', entityId: id, action: 'published', actorId: u.id, newValue: { status: 'published', externalId } })

  return c.json({ id, status: 'published', external_id: externalId, message: `Published to ${posting.channel_name}` })
})

api.post('/postings/:id/retry', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'distribution.manage')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare("UPDATE job_postings SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'failed'")
    .bind(nowIso(), id).run()
  await c.env.DB.prepare('INSERT INTO job_posting_events (posting_id, action, status, detail, actor_id, created_at) VALUES (?,?,?,?,?,?)')
    .bind(id, 'retry', 'queued', 'Retry requested', u.id, nowIso()).run()
  return c.json({ id, message: 'Posting requeued — attempts will increment on the next publish' })
})

api.post('/postings/:id/withdraw', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'distribution.manage')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  const posting = await c.env.DB.prepare('SELECT * FROM job_postings WHERE id = ?').bind(id).first<any>()
  if (!posting) return c.json({ error: 'not_found' }, 404)
  const guard = assertTransition(POSTING_TRANSITIONS, posting.status, 'withdrawn')
  if (!guard.ok) return c.json({ error: 'invalid_transition', message: guard.message }, 422)
  await c.env.DB.prepare("UPDATE job_postings SET status = 'withdrawn', withdrawn_at = ?, updated_at = ? WHERE id = ?")
    .bind(nowIso(), nowIso(), id).run()
  await c.env.DB.prepare('INSERT INTO job_posting_events (posting_id, action, status, detail, actor_id, created_at) VALUES (?,?,?,?,?,?)')
    .bind(id, 'withdraw', 'withdrawn', 'Withdrawn by user', u.id, nowIso()).run()
  await audit(c.env.DB, { entityType: 'posting', entityId: id, action: 'withdrawn', actorId: u.id, previousValue: posting.status })
  return c.json({ id, message: 'Posting withdrawn' })
})

/* ========================================================== automation */
api.post('/automation/rules', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'automation.manage')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  if (!b.name || !b.trigger_event) return c.json({ error: 'validation', message: 'Name and trigger event are required' }, 400)

  const conditions = b.cond_field && b.cond_field.trim()
    ? [{ field: b.cond_field, op: b.cond_op || 'eq', value: b.cond_value }]
    : []
  const actions = [{
    type: b.action_type || 'log_only',
    title: b.action_title || undefined,
    template_id: b.template_id ? Number(b.template_id) : undefined,
    due_in_hours: b.due_in_hours ? Number(b.due_in_hours) : undefined,
    user_id: b.user_id ? Number(b.user_id) : undefined
  }]

  const res = await c.env.DB.prepare(
    `INSERT INTO automation_rules (name, description, trigger_event, conditions, actions, enabled, test_mode, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    String(b.name), b.description || null, String(b.trigger_event),
    JSON.stringify(conditions), JSON.stringify(actions),
    b.enabled === false ? 0 : 1, b.test_mode ? 1 : 0, u.id, nowIso(), nowIso()
  ).run()
  await audit(c.env.DB, { entityType: 'automation_rule', entityId: Number(res.meta.last_row_id), action: 'created', actorId: u.id })
  return c.json({ id: Number(res.meta.last_row_id), message: 'Automation rule created' }, 201)
})

api.patch('/automation/rules/:id', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'automation.manage')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  const b = await c.req.json<any>().catch(() => ({}))
  const rule = await c.env.DB.prepare('SELECT * FROM automation_rules WHERE id = ?').bind(id).first<any>()
  if (!rule) return c.json({ error: 'not_found' }, 404)

  const patch: Record<string, any> = {}
  if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0
  if (b.test_mode !== undefined) patch.test_mode = b.test_mode ? 1 : 0
  if (b.name) patch.name = String(b.name)
  if (b.description !== undefined) patch.description = b.description
  if (!Object.keys(patch).length) return c.json({ error: 'validation', message: 'No fields to update' }, 400)

  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ')
  await c.env.DB.prepare(`UPDATE automation_rules SET ${sets}, updated_at = ? WHERE id = ?`)
    .bind(...Object.values(patch), nowIso(), id).run()
  await audit(c.env.DB, { entityType: 'automation_rule', entityId: id, action: 'updated', actorId: u.id, previousValue: { enabled: rule.enabled, test_mode: rule.test_mode }, newValue: patch })
  return c.json({ id, message: 'Rule updated' })
})

api.post('/automation/rules/:id/test', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'automation.manage')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  const rule = await c.env.DB.prepare('SELECT * FROM automation_rules WHERE id = ?').bind(id).first<any>()
  if (!rule) return c.json({ error: 'not_found' }, 404)

  const sampleApp = await c.env.DB.prepare(
    'SELECT a.id, a.candidate_id, a.job_id FROM applications a ORDER BY a.id DESC LIMIT 1'
  ).first<any>()
  await c.env.DB.prepare('UPDATE automation_rules SET test_mode = 1 WHERE id = ?').bind(id).run()
  const { emitEvent } = await import('../lib/audit')
  const out = await emitEvent(c.env.DB, rule.trigger_event, {
    application_id: sampleApp?.id, candidate_id: sampleApp?.candidate_id, job_id: sampleApp?.job_id,
    to_stage: 'manager_review', days_open: 60, dry_run: true
  }, { eventKey: `dryrun:${id}:${hashString(nowIso())}`, actorId: u.id })

  return c.json({ id, dry_run: true, results: out.runs, message: 'Dry run complete — no messages or tasks were created' })
})

/* ================================================================= SLA */
api.post('/sla/escalate', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'sla.read')) return c.json({ error: 'forbidden' }, 403)
  const out = await escalateOverdue(c.env.DB, u.id)
  await audit(c.env.DB, { entityType: 'sla', entityId: 'escalation', action: 'escalated', actorId: u.id, meta: out })
  return c.json({ ...out, message: `${out.created} escalation task(s) created for ${out.overdue} overdue application(s)` })
})

api.patch('/sla/settings/:stage', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'sla.manage')) return c.json({ error: 'forbidden', message: 'Only administrators can change SLA thresholds' }, 403)
  const stage = c.req.param('stage')
  const b = await c.req.json<any>().catch(() => ({}))
  const hours = Number(b.threshold_hours)
  if (!Number.isFinite(hours) || hours < 1) return c.json({ error: 'validation', message: 'Threshold must be at least 1 hour' }, 400)

  await c.env.DB.prepare(
    `INSERT INTO sla_settings (scope, stage, threshold_hours, escalate_to, enabled, updated_at)
     VALUES ('stage', ?, ?, ?, 1, ?)
     ON CONFLICT(scope, stage) DO UPDATE SET threshold_hours = excluded.threshold_hours, updated_at = excluded.updated_at`
  ).bind(stage, hours, 'talent-ops@vsolutions.dev', nowIso()).run()
  await audit(c.env.DB, { entityType: 'sla_setting', entityId: stage, action: 'updated', actorId: u.id, newValue: { threshold_hours: hours } })
  return c.json({ stage, threshold_hours: hours, message: `SLA for ${stage} set to ${hours}h` })
})

/* =========================================================== analytics */
api.get('/analytics', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'analytics.read')) return c.json({ error: 'forbidden' }, 403)
  const q = c.req.query()
  const analytics = await loadAnalytics(c.env.DB, {
    from: q.from, to: q.to,
    jobId: q.jobId ? Number(q.jobId) : undefined,
    recruiterId: q.recruiterId ? Number(q.recruiterId) : undefined,
    location: q.location, source: q.source
  })
  return c.json({ analytics, insights: sourceInsights(analytics), definitions: METRIC_DEFS })
})

api.get('/analytics/export.csv', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'analytics.export')) return c.json({ error: 'forbidden' }, 403)
  const q = c.req.query()
  const analytics = await loadAnalytics(c.env.DB, {
    from: q.from, to: q.to,
    jobId: q.jobId ? Number(q.jobId) : undefined,
    recruiterId: q.recruiterId ? Number(q.recruiterId) : undefined,
    location: q.location, source: q.source
  })

  const rows: any[][] = [
    ['section', 'label', 'value', 'unit', 'numerator', 'denominator']
  ]
  for (const def of METRIC_DEFS) {
    rows.push(['metric', def.label, analytics.metrics[def.key], def.unit, def.definition, `${analytics.denominators.applications} apps`])
  }
  rows.push([])
  rows.push(['section', 'stage', 'count', 'conversion_prev_pct', 'conversion_top_pct'])
  for (const f of analytics.funnel) rows.push(['funnel', f.stage, f.count, f.conversion_from_previous, f.conversion_from_top])
  rows.push([])
  rows.push(['section', 'source', 'applications', 'shortlisted', 'interviewed', 'hired', 'conversion_pct'])
  for (const s of analytics.bySource) rows.push(['source', s.source, s.applications, s.shortlisted, s.interviewed, s.hired, s.conversion])
  rows.push([])
  rows.push(['section', 'reason', 'count'])
  for (const d of analytics.dropOffReasons) rows.push(['drop_off', d.reason, d.count])

  await audit(c.env.DB, { entityType: 'analytics', entityId: 'export', action: 'exported', actorId: u.id, meta: { filters: q } })
  return new Response(csv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="recruitment-analytics-${nowIso().slice(0, 10)}.csv"`
    }
  })
})

api.get('/audit/export.csv', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'audit.read')) return c.json({ error: 'forbidden' }, 403)
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 5000`
  ).all<any>()
  const rows: any[][] = [['id', 'created_at', 'actor', 'entity_type', 'entity_id', 'action', 'previous_value', 'new_value', 'reason']]
  for (const r of results) rows.push([r.id, r.created_at, r.actor_name, r.entity_type, r.entity_id, r.action, r.previous_value, r.new_value, r.reason])
  return new Response(csv(rows), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit-trail.csv"' }
  })
})

/* ================================================================== AI */
api.post('/ai/summary', requireAuth, async (c) => {
  const u = currentUser(c)
  const b = await c.req.json<any>().catch(() => ({}))
  if (!b.candidate_id) return c.json({ error: 'validation', message: 'candidate_id is required' }, 400)
  const out = await summarizeCandidate(c.env.DB, Number(b.candidate_id), b.job_id ? Number(b.job_id) : null)
  return c.json(out)
})

api.post('/ai/compare', requireAuth, async (c) => {
  const b = await c.req.json<any>().catch(() => ({}))
  if (!b.job_id || !Array.isArray(b.candidate_ids) || !b.candidate_ids.length) {
    return c.json({ error: 'validation', message: 'job_id and candidate_ids[] are required' }, 400)
  }
  const out = await compareCandidates(c.env.DB, Number(b.job_id), b.candidate_ids.map(Number))
  return c.json(out)
})

api.post('/ai/feedback-summary', requireAuth, async (c) => {
  const b = await c.req.json<any>().catch(() => ({}))
  if (!b.application_id) return c.json({ error: 'validation', message: 'application_id is required' }, 400)
  const out = await summarizeFeedback(c.env.DB, Number(b.application_id))
  return c.json(out)
})

api.get('/ai/interpret', requireAuth, async (c) => {
  const q = c.req.query('q') || ''
  return c.json(interpretQuery(q))
})

/* ================================================================ users */
api.post('/users', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.users')) return c.json({ error: 'forbidden', message: 'Only administrators can add users' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const name = String(b.name || '').trim()
  const email = String(b.email || '').trim().toLowerCase()
  const role = String(b.role || 'recruiter')
  const password = String(b.password || '')
  if (!name || !email) return c.json({ error: 'validation', message: 'Name and email are required' }, 400)
  if (!['admin', 'recruiter', 'hiring_manager', 'interviewer', 'coordinator'].includes(role)) {
    return c.json({ error: 'validation', message: 'Unknown role' }, 400)
  }
  if (password.length < 8) return c.json({ error: 'validation', message: 'Password must be at least 8 characters' }, 400)

  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE lower(email) = ?').bind(email).first<any>()
  if (exists) return c.json({ error: 'duplicate_email', message: 'A user with this email already exists' }, 409)

  const { hashPassword } = await import('../lib/auth')
  const hash = await hashPassword(password)
  const res = await c.env.DB.prepare(
    'INSERT INTO users (email, name, role, title, department, password_hash, active) VALUES (?,?,?,?,?,?,1)'
  ).bind(email, name, role, b.title || null, b.department || null, hash).run()
  await audit(c.env.DB, { entityType: 'user', entityId: Number(res.meta.last_row_id), action: 'created', actorId: u.id, newValue: { email, role } })
  return c.json({ id: Number(res.meta.last_row_id), message: 'User created' }, 201)
})

api.patch('/users/:id', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.users')) return c.json({ error: 'forbidden' }, 403)
  const id = Number(c.req.param('id'))
  if (id === u.id) return c.json({ error: 'self_modification', message: 'You cannot deactivate your own account' }, 422)
  const b = await c.req.json<any>().catch(() => ({}))
  const before = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<any>()
  if (!before) return c.json({ error: 'not_found' }, 404)

  if (b.active !== undefined) {
    await c.env.DB.prepare('UPDATE users SET active = ? WHERE id = ?').bind(b.active ? 1 : 0, id).run()
    if (!b.active) await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run()
  }
  if (b.role) await c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(String(b.role), id).run()

  await audit(c.env.DB, {
    entityType: 'user', entityId: id, action: 'updated', actorId: u.id,
    previousValue: { active: before.active, role: before.role },
    newValue: { active: b.active ? 1 : 0, role: b.role || before.role }
  })
  return c.json({ id, message: 'User updated' })
})
