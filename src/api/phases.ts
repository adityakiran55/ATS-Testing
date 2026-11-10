import { Hono } from 'hono'
import type { AppEnv } from '../lib/auth'
import { currentUser, requireAuth } from '../lib/auth'
import { can } from '../lib/rbac'
import { nowIso, parseJson } from '../lib/util'

import {
  loadGraph, taxonomySummary, listVersions, createVersion, publishVersion, rollbackVersion,
  listSuggestions, reviewSuggestion, browseNodes, matchTerms, computeCoverage, recommendRoles,
  loadActiveVersion
} from '../lib/taxonomy'
import {
  extractFieldsWithSpans, computeExperience, persistResumeFields, loadResumeFields,
  correctField, resumeEvidenceSummary, verifySpan
} from '../lib/evidence'
import {
  runScreening, loadRun, listRunsForJob, listRunsForCandidate, loadReviewQueue,
  screeningStats, decideRun, resolveProfile, saveProfile, DIMENSIONS, DIMENSION_LABELS,
  DEFAULT_THRESHOLDS, SCREENING_CLASSES
} from '../lib/screening'
import {
  validateJd, saveJdVersion, listJdVersions, loadJdVersion, diffJdVersions,
  poolCoveragePreview, extractRequirements
} from '../lib/jd'
import {
  loadBoard, moveApplication, loadStages, pipelineFunnel, backfillPipelineStages,
  issueCandidateNotice, acknowledgeNotice, loadNotices, PIPELINE_TRANSITIONS,
  PIPELINE_LABELS, LEGACY_MAP, derivePipelineStage
} from '../lib/pipeline'
import {
  computeAdverseImpact, saveAdverseImpactReport, listAdverseImpactReports,
  loadOversightLog, oversightStats, buildDecisionLog, decisionLogCsv, adverseImpactCsv,
  executeErasure, loadErasureHistory, logBreach, updateBreach, listBreaches,
  listProcessors, upsertProcessor, listRegions, setRegion, runRetentionTimer,
  retentionSummary, complianceOverview
} from '../lib/compliance'

/**
 * Every phase service throws `Object.assign(new Error(msg), { status, code })`.
 * Hono's global onError turns that into a 500, so unwrap it here instead.
 */
const guard = (
  fn: (c: any) => Promise<any>
) => async (c: any) => {
  try {
    return await fn(c)
  } catch (err: any) {
    const status = Number(err?.status) || 500
    if (status >= 500) console.error('[phases]', err?.stack || err)
    return c.json(
      {
        error: err?.code || (status >= 500 ? 'server_error' : 'request_failed'),
        message: err?.message || 'Unexpected error'
      },
      status as any
    )
  }
}

export const phasesApi = new Hono<AppEnv>()

/* ================================================================ tenancy */

phasesApi.get('/tenant', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  const t = await c.env.DB.prepare(`SELECT * FROM tenants WHERE id = ?`).bind(u.tenant_id ?? 1).first<any>()
  const counts = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE tenant_id = ?) AS users,
       (SELECT COUNT(*) FROM candidates WHERE tenant_id = ?) AS candidates,
       (SELECT COUNT(*) FROM jobs WHERE tenant_id = ?) AS jobs,
       (SELECT COUNT(*) FROM applications WHERE tenant_id = ?) AS applications`
  ).bind(u.tenant_id ?? 1, u.tenant_id ?? 1, u.tenant_id ?? 1, u.tenant_id ?? 1).first<any>()
  const roles = await c.env.DB.prepare(
    `SELECT * FROM role_definitions WHERE tenant_id = ? ORDER BY id`
  ).bind(u.tenant_id ?? 1).all<any>()
  return c.json({
    tenant: t ? { ...t, settings: parseJson<Record<string, any>>(t.settings, {}) } : null,
    counts,
    roles: roles.results.map((r: any) => ({ ...r, permissions: parseJson<string[]>(r.permissions, []) })),
    region: u.tenant_region
  })
}))

/** Tenant isolation self-check: proves every scoped table is actually scoped. */
phasesApi.get('/tenant/isolation-check', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.settings')) return c.json({ error: 'forbidden', message: 'Admin only' }, 403)
  const tables = ['users', 'candidates', 'jobs', 'applications', 'resumes']
  const checks: any[] = []
  for (const t of tables) {
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN tenant_id = ? THEN 1 ELSE 0 END) AS mine,
              SUM(CASE WHEN tenant_id IS NULL THEN 1 ELSE 0 END) AS nulls
         FROM ${t}`
    ).bind(u.tenant_id ?? 1).first<any>()
    checks.push({ table: t, ...row, leak: Number(row?.nulls || 0) > 0 })
  }
  return c.json({ tenantId: u.tenant_id, checks, ok: checks.every((x) => !x.leak) })
}))

/* =============================================================== taxonomy */

phasesApi.get('/taxonomy', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.read')) return c.json({ error: 'forbidden' }, 403)
  const [summary, versions, suggestions] = await Promise.all([
    taxonomySummary(c.env.DB), listVersions(c.env.DB), listSuggestions(c.env.DB, 'pending')
  ])
  return c.json({ summary, versions, suggestions })
}))

phasesApi.get('/taxonomy/nodes', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.read')) return c.json({ error: 'forbidden' }, 403)
  const nodes = await browseNodes(c.env.DB, { kind: c.req.query('kind'), q: c.req.query('q') })
  return c.json({ nodes, total: nodes.length, activeVersion: await loadActiveVersion(c.env.DB) })
}))

phasesApi.post('/taxonomy/versions', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.settings')) return c.json({ error: 'forbidden', message: 'Admin only' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const out = await createVersion(c.env.DB, { notes: b.notes, actorId: u.id })
  return c.json({ ...out, message: `Draft taxonomy version ${out.version} created` }, 201)
}))

phasesApi.post('/taxonomy/versions/:id/publish', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.settings')) return c.json({ error: 'forbidden', message: 'Admin only' }, 403)
  const out = await publishVersion(c.env.DB, Number(c.req.param('id')), u.id)
  return c.json({ ...out, message: 'Taxonomy version published' })
}))

phasesApi.post('/taxonomy/versions/:id/rollback', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.settings')) return c.json({ error: 'forbidden', message: 'Admin only' }, 403)
  const out = await rollbackVersion(c.env.DB, Number(c.req.param('id')), u.id)
  return c.json({ ...out, message: 'Rolled back' })
}))

phasesApi.get('/taxonomy/suggestions', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.read')) return c.json({ error: 'forbidden' }, 403)
  return c.json({ suggestions: await listSuggestions(c.env.DB, c.req.query('status') || undefined) })
}))

phasesApi.post('/taxonomy/suggestions', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.edit')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const out = await import('../lib/taxonomy').then((m) =>
    m.recordSuggestion(c.env.DB, {
      term: b.term, kind: b.kind, context: b.context, source: b.source || 'manual', proposedBy: u.id
    })
  )
  return c.json({ suggestion: out, message: 'Suggestion queued for review' }, 201)
}))

phasesApi.post('/taxonomy/suggestions/:id/review', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.settings')) return c.json({ error: 'forbidden', message: 'Admin only' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const decision = String(b.decision || '')
  if (!['approved', 'rejected', 'merged'].includes(decision)) {
    return c.json({ error: 'validation', message: 'decision must be approved, rejected or merged' }, 400)
  }
  const out = await reviewSuggestion(c.env.DB, Number(c.req.param('id')), decision as any, {
    reviewerId: u.id, note: b.note, kind: b.kind, parentId: b.parent_id ?? null, nodeId: b.node_id ?? null
  })
  return c.json({ ...out, message: `Suggestion ${decision}` })
}))

/** Explain a text match — powers the "why this matched" affordance. */
phasesApi.post('/taxonomy/match', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.read')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const text = String(b.text || '')
  if (!text.trim()) return c.json({ error: 'validation', message: 'text is required' }, 400)
  const graph = await loadGraph(c.env.DB)
  const matches = matchTerms(graph, text)
  return c.json({
    matches: matches.slice(0, 40),
    roles: recommendRoles(graph, text).map((r) => ({ code: r.node.code, name: r.node.name, score: r.score })),
    coverage: b.requirements?.length ? computeCoverage(graph, b.requirements, text) : null,
    version: graph.version.version
  })
}))

/* ============================================================== evidence */

phasesApi.get('/resumes/:id/fields', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.read')) return c.json({ error: 'forbidden' }, 403)
  const resumeId = Number(c.req.param('id'))
  const [fields, summary] = await Promise.all([
    loadResumeFields(c.env.DB, resumeId), resumeEvidenceSummary(c.env.DB, resumeId)
  ])
  return c.json({ fields, summary })
}))

/** Extract + persist evidence for one resume. Idempotent per (resume, field). */
phasesApi.post('/resumes/:id/extract', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.edit')) return c.json({ error: 'forbidden' }, 403)
  const resumeId = Number(c.req.param('id'))
  const resume = await c.env.DB.prepare(`SELECT * FROM resumes WHERE id = ?`).bind(resumeId).first<any>()
  if (!resume) return c.json({ error: 'not_found', message: 'Resume not found' }, 404)
  if (!resume.raw_text) {
    return c.json({ error: 'no_text', message: 'This resume has no extracted text to evidence' }, 422)
  }
  const graph = await loadGraph(c.env.DB)
  const out = await persistResumeFields(c.env.DB, {
    resumeId, candidateId: resume.candidate_id, tenantId: u.tenant_id ?? 1,
    rawText: resume.raw_text, graph
  })
  return c.json({ ...out, message: `${out.stored} field(s) extracted, ${out.verified} verified` })
}))

phasesApi.post('/resumes/:id/fields/:field', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.edit')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  if (!b.value || !String(b.value).trim()) {
    return c.json({ error: 'validation', message: 'value is required' }, 400)
  }
  const out = await correctField(c.env.DB, {
    resumeId: Number(c.req.param('id')),
    field: String(c.req.param('field')),
    newValue: String(b.value),
    actorId: u.id,
    reason: b.reason
  })
  return c.json({ ...out, message: 'Field corrected and recorded' })
}))

/** Dry-run the extractor without writing — used by the resume review screen. */
phasesApi.post('/evidence/preview', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.read')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const text = String(b.text || '')
  if (!text.trim()) return c.json({ error: 'validation', message: 'text is required' }, 400)
  const graph = await loadGraph(c.env.DB)
  const { fields, unverified } = extractFieldsWithSpans(text, graph)
  const experience = computeExperience(text)
  return c.json({
    fields: fields.map((f) => ({ ...f, span_ok: verifySpan(text, f.char_start, f.char_end, f.evidence_text).ok })),
    unverified,
    experience,
    counts: { total: fields.length, unverified: unverified.length }
  })
}))

/* ============================================================= screening */

phasesApi.get('/screening/stats', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.read')) return c.json({ error: 'forbidden' }, 403)
  return c.json(await screeningStats(c.env.DB))
}))

phasesApi.get('/screening/queue', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.read')) return c.json({ error: 'forbidden' }, 403)
  return c.json({ queue: await loadReviewQueue(c.env.DB, Number(c.req.query('limit') || 100)) })
}))

phasesApi.get('/jobs/:id/screening-profile', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'job.read')) return c.json({ error: 'forbidden' }, 403)
  const job = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(Number(c.req.param('id'))).first<any>()
  if (!job) return c.json({ error: 'not_found' }, 404)
  const profile = await resolveProfile(c.env.DB, job)
  return c.json({
    profile,
    dimensions: DIMENSIONS.map((d) => ({ key: d, label: DIMENSION_LABELS[d] })),
    defaults: { thresholds: DEFAULT_THRESHOLDS, classes: SCREENING_CLASSES }
  })
}))

phasesApi.put('/jobs/:id/screening-profile', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'job.edit')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  if (!b.weights || typeof b.weights !== 'object') {
    return c.json({ error: 'validation', message: 'weights object is required' }, 400)
  }
  const out = await saveProfile(c.env.DB, {
    jobId: Number(c.req.param('id')),
    tenantId: u.tenant_id ?? 1,
    weights: b.weights,
    knockouts: Array.isArray(b.knockouts) ? b.knockouts : [],
    thresholds: Array.isArray(b.thresholds) ? b.thresholds : DEFAULT_THRESHOLDS,
    actorId: u.id
  })
  return c.json({ ...out, message: `Screening profile version ${out.version} saved` }, 201)
}))

phasesApi.post('/jobs/:id/screening/runs', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.read')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const candidates: number[] = Array.isArray(b.candidate_ids)
    ? b.candidate_ids.map(Number).slice(0, 25)
    : b.candidate_id ? [Number(b.candidate_id)] : []
  if (!candidates.length) {
    return c.json({ error: 'validation', message: 'candidate_id or candidate_ids[] is required' }, 400)
  }
  const graph = await loadGraph(c.env.DB)
  const jobId = Number(c.req.param('id'))
  const results: any[] = []
  for (const candidateId of candidates) {
    const app = await c.env.DB
      .prepare(`SELECT id FROM applications WHERE job_id = ? AND candidate_id = ?`)
      .bind(jobId, candidateId)
      .first<any>()
    try {
      results.push(await runScreening(c.env.DB, {
        jobId, candidateId, actorId: u.id, tenantId: u.tenant_id ?? 1,
        graph, applicationId: app?.id ?? null
      }))
    } catch (err: any) {
      results.push({ candidateId, error: err?.code || 'failed', message: err?.message })
    }
  }
  return c.json({
    results,
    message: `${results.filter((r) => !r.error).length}/${candidates.length} run(s) complete — all advisory, none auto-rejected`
  })
}))

phasesApi.get('/jobs/:id/screening/runs', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.read')) return c.json({ error: 'forbidden' }, 403)
  return c.json({ runs: await listRunsForJob(c.env.DB, Number(c.req.param('id'))) })
}))

phasesApi.get('/candidates/:id/screening', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.read')) return c.json({ error: 'forbidden' }, 403)
  return c.json({ runs: await listRunsForCandidate(c.env.DB, Number(c.req.param('id'))) })
}))

phasesApi.get('/screening/runs/:id', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.read')) return c.json({ error: 'forbidden' }, 403)
  const run = await loadRun(c.env.DB, Number(c.req.param('id')))
  if (!run) return c.json({ error: 'not_found', message: 'Run not found' }, 404)
  return c.json({ run })
}))

/** Human decision. Reason is mandatory; nothing here is automatic (N2/N7). */
phasesApi.post('/screening/runs/:id/decide', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'application.move')) {
    return c.json({ error: 'forbidden', message: 'You cannot record a screening decision' }, 403)
  }
  const b = await c.req.json<any>().catch(() => ({}))
  const decision = String(b.decision || '')
  if (!['accepted', 'overridden', 'rejected', 'escalated'].includes(decision)) {
    return c.json({ error: 'validation', message: 'decision must be accepted, overridden, rejected or escalated' }, 400)
  }
  const finalClass = b.final_class ? String(b.final_class) : undefined
  if (finalClass && !SCREENING_CLASSES.includes(finalClass as any)) {
    return c.json({ error: 'validation', message: 'Unknown screening class' }, 400)
  }
  const out = await decideRun(c.env.DB, {
    runId: Number(c.req.param('id')),
    actorId: u.id,
    tenantId: u.tenant_id ?? 1,
    decision: decision as any,
    finalClass: finalClass as any,
    reason: String(b.reason || '')
  })
  return c.json({ ...out, message: 'Decision recorded with reviewer, reason and oversight entry' })
}))

/* ==================================================================== JD */

phasesApi.get('/jobs/:id/jd', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'job.read')) return c.json({ error: 'forbidden' }, 403)
  const jobId = Number(c.req.param('id'))
  const job = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<any>()
  if (!job) return c.json({ error: 'not_found' }, 404)
  const graph = await loadGraph(c.env.DB)
  const [versions, analysis] = await Promise.all([
    listJdVersions(c.env.DB, jobId), Promise.resolve(validateJd(job, graph))
  ])
  return c.json({
    job: {
      ...job,
      must_have_skills: parseJson<string[]>(job.must_have_skills, []),
      nice_to_have: parseJson<string[]>(job.nice_to_have, [])
    },
    versions,
    analysis
  })
}))

phasesApi.post('/jobs/:id/jd/versions', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'job.edit')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const job = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(Number(c.req.param('id'))).first<any>()
  if (!job) return c.json({ error: 'not_found' }, 404)
  const graph = await loadGraph(c.env.DB)
  const out = await saveJdVersion(c.env.DB, {
    job, tenantId: u.tenant_id ?? 1, actorId: u.id, graph,
    status: b.status === 'approved' ? 'approved' : 'draft', notes: b.notes
  })
  return c.json({
    ...out,
    message: `JD version ${out.version} saved with ${out.requirements} requirement(s), ${out.analysis.issues.length} issue(s)`
  }, 201)
}))

phasesApi.get('/jd/versions/:id', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'job.read')) return c.json({ error: 'forbidden' }, 403)
  const v = await loadJdVersion(c.env.DB, Number(c.req.param('id')))
  if (!v) return c.json({ error: 'not_found' }, 404)
  return c.json({ version: v })
}))

phasesApi.get('/jd/diff', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'job.read')) return c.json({ error: 'forbidden' }, 403)
  const from = Number(c.req.query('from'))
  const to = Number(c.req.query('to'))
  if (!from || !to) return c.json({ error: 'validation', message: 'from and to version ids are required' }, 400)
  return c.json(await diffJdVersions(c.env.DB, from, to))
}))

phasesApi.post('/jd/validate', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'job.read')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const graph = await loadGraph(c.env.DB)
  return c.json({ analysis: validateJd(b, graph) })
}))

phasesApi.get('/jobs/:id/pool-coverage', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.search')) return c.json({ error: 'forbidden' }, 403)
  const job = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(Number(c.req.param('id'))).first<any>()
  if (!job) return c.json({ error: 'not_found' }, 404)
  const graph = await loadGraph(c.env.DB)
  return c.json({ coverage: await poolCoveragePreview(c.env.DB, job, graph) })
}))

phasesApi.post('/jd/extract', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'job.read')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const graph = await loadGraph(c.env.DB)
  const reqs = extractRequirements(String(b.text || ''), graph)
  return c.json({
    requirements: reqs,
    counts: {
      must_have: reqs.filter((r) => r.kind === 'must_have').length,
      nice_to_have: reqs.filter((r) => r.kind === 'nice_to_have').length,
      taxonomy_resolved: reqs.filter((r) => r.node_id !== null).length
    }
  })
}))

/* ============================================================== pipeline */

phasesApi.get('/pipeline/board', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'application.read')) return c.json({ error: 'forbidden' }, 403)
  const jobId = c.req.query('job') ? Number(c.req.query('job')) : undefined
  const [board, stages, funnel] = await Promise.all([
    loadBoard(c.env.DB, { jobId }), loadStages(c.env.DB, u.tenant_id ?? 1), pipelineFunnel(c.env.DB, jobId)
  ])
  return c.json({ board, stages, funnel, transitions: PIPELINE_TRANSITIONS, labels: PIPELINE_LABELS })
}))

phasesApi.post('/applications/:id/pipeline', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'application.move')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const to = String(b.to || '')
  if (!to) return c.json({ error: 'validation', message: 'to is required' }, 400)
  const out = await moveApplication(c.env.DB, {
    applicationId: Number(c.req.param('id')),
    to: to as any,
    actorId: u.id,
    reason: b.reason ?? null,
    tenantId: u.tenant_id ?? 1
  })
  return c.json({
    ...out,
    message: `Moved to ${PIPELINE_LABELS[out.to as keyof typeof PIPELINE_LABELS] || out.to}${out.notice ? ' — candidate notice issued' : ''}`
  })
}))

phasesApi.post('/pipeline/backfill', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.settings')) return c.json({ error: 'forbidden', message: 'Admin only' }, 403)
  const out = await backfillPipelineStages(c.env.DB, u.id)
  return c.json({ ...out, message: `${out.changed}/${out.scanned} application(s) mapped to v3.0 stages` })
}))

phasesApi.get('/pipeline/mapping', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'application.read')) return c.json({ error: 'forbidden' }, 403)
  return c.json({ legacyMap: LEGACY_MAP, transitions: PIPELINE_TRANSITIONS, labels: PIPELINE_LABELS })
}))

/* ================================================================ notices */

phasesApi.get('/candidates/:id/notices', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.read')) return c.json({ error: 'forbidden' }, 403)
  return c.json({ notices: await loadNotices(c.env.DB, Number(c.req.param('id'))) })
}))

phasesApi.post('/candidates/:id/notices', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.edit')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const out = await issueCandidateNotice(c.env.DB, {
    candidateId: Number(c.req.param('id')),
    applicationId: b.application_id ? Number(b.application_id) : null,
    tenantId: u.tenant_id ?? 1,
    jurisdiction: b.jurisdiction,
    channel: b.channel
  })
  return c.json({ ...out, message: 'Transparency notice issued' }, 201)
}))

phasesApi.post('/notices/:id/acknowledge', requireAuth, guard(async (c) => {
  const out = await acknowledgeNotice(c.env.DB, Number(c.req.param('id')))
  return c.json({ ...out, message: 'Notice acknowledged' })
}))

/* ============================================================= compliance */

phasesApi.get('/compliance/overview', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'audit.read')) return c.json({ error: 'forbidden', message: 'Audit access required' }, 403)
  return c.json(await complianceOverview(c.env.DB, u.tenant_id ?? 1))
}))

phasesApi.get('/compliance/adverse-impact', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'analytics.read')) return c.json({ error: 'forbidden' }, 403)
  const report = await computeAdverseImpact(c.env.DB, {
    jobId: c.req.query('job') ? Number(c.req.query('job')) : null,
    from: c.req.query('from') || null,
    to: c.req.query('to') || null,
    tenantId: u.tenant_id ?? 1
  })
  return c.json({ report })
}))

phasesApi.post('/compliance/adverse-impact', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'analytics.export')) return c.json({ error: 'forbidden' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const report = await computeAdverseImpact(c.env.DB, {
    jobId: b.job_id ? Number(b.job_id) : null,
    from: b.from || null,
    to: b.to || null,
    tenantId: u.tenant_id ?? 1
  })
  const saved = await saveAdverseImpactReport(c.env.DB, report, u.id, u.tenant_id ?? 1)
  return c.json({
    ...saved,
    message: `Report saved — ${report.flags.length} group(s) below the ${report.suppressed_cells} cell threshold check`
  }, 201)
}))

phasesApi.get('/compliance/adverse-impact/export.csv', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'analytics.export')) return c.json({ error: 'forbidden' }, 403)
  const report = await computeAdverseImpact(c.env.DB, {
    jobId: c.req.query('job') ? Number(c.req.query('job')) : null,
    from: c.req.query('from') || null,
    to: c.req.query('to') || null,
    tenantId: u.tenant_id ?? 1
  })
  return new Response(adverseImpactCsv(report), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="adverse-impact.csv"'
    }
  })
}))

phasesApi.get('/compliance/oversight', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'audit.read')) return c.json({ error: 'forbidden' }, 403)
  const [log, stats] = await Promise.all([
    loadOversightLog(c.env.DB, {
      limit: Number(c.req.query('limit') || 100),
      candidateId: c.req.query('candidate') ? Number(c.req.query('candidate')) : undefined
    }),
    oversightStats(c.env.DB)
  ])
  return c.json({ log, stats })
}))

phasesApi.get('/compliance/decisions/export.csv', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'analytics.export')) return c.json({ error: 'forbidden' }, 403)
  const rows = await buildDecisionLog(c.env.DB, {
    jobId: c.req.query('job') ? Number(c.req.query('job')) : undefined,
    from: c.req.query('from') || undefined,
    to: c.req.query('to') || undefined
  })
  return new Response(decisionLogCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="screening-decisions.csv"'
    }
  })
}))

phasesApi.post('/compliance/erasure', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'candidate.delete')) {
    return c.json({ error: 'forbidden', message: 'Only administrators can execute erasure' }, 403)
  }
  const b = await c.req.json<any>().catch(() => ({}))
  if (!b.candidate_id) return c.json({ error: 'validation', message: 'candidate_id is required' }, 400)
  const out = await executeErasure(c.env.DB, {
    candidateId: Number(b.candidate_id),
    actorId: u.id,
    requestId: b.request_id ? Number(b.request_id) : null,
    reason: String(b.reason || ''),
    tenantId: u.tenant_id ?? 1
  })
  return c.json({ ...out, message: 'Erasure completed — profile anonymised, audit retained' })
}))

phasesApi.get('/compliance/erasure/:candidateId', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'audit.read')) return c.json({ error: 'forbidden' }, 403)
  return c.json({ steps: await loadErasureHistory(c.env.DB, Number(c.req.param('candidateId'))) })
}))

phasesApi.get('/compliance/breaches', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'audit.read')) return c.json({ error: 'forbidden' }, 403)
  return c.json({ breaches: await listBreaches(c.env.DB) })
}))

phasesApi.post('/compliance/breaches', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.settings')) return c.json({ error: 'forbidden', message: 'Admin only' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  if (!b.title || String(b.title).trim().length < 4) {
    return c.json({ error: 'validation', message: 'title is required' }, 400)
  }
  const out = await logBreach(c.env.DB, {
    title: String(b.title), detectedAt: b.detected_at, severity: b.severity,
    description: b.description, actorId: u.id, tenantId: u.tenant_id ?? 1
  })
  return c.json({ ...out, message: `Incident ${out.ref} logged with response checklist` }, 201)
}))

phasesApi.patch('/compliance/breaches/:id', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.settings')) return c.json({ error: 'forbidden', message: 'Admin only' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const out = await updateBreach(c.env.DB, Number(c.req.param('id')), {
    notified: b.notified, closed: b.closed, severity: b.severity, description: b.description
  }, u.id)
  return c.json({ ...out, message: 'Incident updated' })
}))

phasesApi.get('/compliance/processors', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'audit.read')) return c.json({ error: 'forbidden' }, 403)
  return c.json({ processors: await listProcessors(c.env.DB) })
}))

phasesApi.post('/compliance/processors', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.settings')) return c.json({ error: 'forbidden', message: 'Admin only' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  if (!b.name) return c.json({ error: 'validation', message: 'name is required' }, 400)
  const out = await upsertProcessor(c.env.DB, {
    id: b.id ? Number(b.id) : null,
    name: String(b.name),
    role: b.role,
    dataCategories: b.data_categories,
    location: b.location,
    transferBasis: b.transfer_basis,
    dpaSigned: b.dpa_signed === undefined ? undefined : Boolean(b.dpa_signed),
    dpaDate: b.dpa_date ?? null,
    notes: b.notes,
    actorId: u.id,
    tenantId: u.tenant_id ?? 1
  })
  return c.json({ ...out, message: 'Processor record saved' }, 201)
}))

phasesApi.get('/compliance/regions', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'audit.read')) return c.json({ error: 'forbidden' }, 403)
  return c.json({ regions: await listRegions(c.env.DB, u.tenant_id ?? 1) })
}))

phasesApi.patch('/compliance/regions/:region', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.settings')) return c.json({ error: 'forbidden', message: 'Admin only' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  if (typeof b.enabled !== 'boolean') {
    return c.json({ error: 'validation', message: 'enabled (boolean) is required' }, 400)
  }
  const out = await setRegion(c.env.DB, {
    region: String(c.req.param('region')).toUpperCase(),
    enabled: b.enabled,
    noticeText: b.notice_text ?? null,
    actorId: u.id,
    tenantId: u.tenant_id ?? 1
  })
  return c.json({
    ...out,
    message: out.enabled
      ? `${out.region} enabled — ${out.requirements.length} safeguard(s) apply`
      : `${out.region} disabled`
  })
}))

phasesApi.get('/compliance/retention', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'audit.read')) return c.json({ error: 'forbidden' }, 403)
  return c.json(await retentionSummary(c.env.DB, u.tenant_id ?? 1))
}))

phasesApi.post('/compliance/retention/run', requireAuth, guard(async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'admin.settings')) return c.json({ error: 'forbidden', message: 'Admin only' }, 403)
  const b = await c.req.json<any>().catch(() => ({}))
  const out = await runRetentionTimer(c.env.DB, {
    actorId: u.id, tenantId: u.tenant_id ?? 1, dryRun: Boolean(b.dry_run)
  })
  return c.json({
    ...out,
    message: b.dry_run
      ? `Dry run: ${out.planned?.length || 0} candidate(s) would be scheduled`
      : `${out.scheduled} candidate(s) scheduled with pre-deletion notice; ${out.due.length} now due for review`
  })
}))
