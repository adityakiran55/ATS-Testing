#!/usr/bin/env node
/**
 * VSolutions ATS v3.0 — Phases 1–7 acceptance tests.
 * Run against a live local instance:  node tests/phases.test.mjs
 * Requires the migrated + seeded D1 database (npm run db:reset).
 *
 * These tests assert behaviour that the spec makes non-negotiable, not just
 * that endpoints return 200:
 *   N1  evidence must resolve to a real span of the source document
 *   N2  a human, named, with a reason, makes every screening decision
 *   N3  protected attributes cannot enter scoring
 *   N5  every read/write is tenant-scoped
 *   N7  the engine can never auto-reject
 *   N8  the taxonomy only grows through human approval
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000'
let pass = 0
const failures = []

const jar = {}
const cookieFor = (who) => Object.entries(jar[who] || {}).map(([k, v]) => `${k}=${v}`).join('; ')

const req = async (who, method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(jar[who] ? { Cookie: cookieFor(who) } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual'
  })
  const setCookie = res.headers.getSetCookie?.() || []
  for (const c of setCookie) {
    const [pair] = c.split(';')
    const [k, v] = pair.split('=')
    jar[who] = jar[who] || {}
    jar[who][k] = v
  }
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 200) } }
  return { status: res.status, data, text }
}

const expect = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  else { failures.push(name); console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${JSON.stringify(detail).slice(0, 240)}` : ''}`) }
}

const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)

const login = async (who, email) => {
  const r = await req(who, 'POST', '/api/auth/login', { email, password: 'Password123!' })
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`)
  return r
}

/* Deterministic-but-unique fixtures so repeated runs do not collide. */
const RUN = Date.now().toString(36)

const main = async () => {
  section('Setup')
  await login('admin', 'admin@vsolutions.dev')
  await login('recruiter', 'recruiter@vsolutions.dev')
  await login('manager', 'manager@vsolutions.dev')
  await login('interviewer', 'interviewer@vsolutions.dev')
  await login('coordinator', 'coordinator@vsolutions.dev')
  expect('five roles authenticated', true)

  /* ==================================================== PHASE 1 — tenancy */
  section('Phase 1 — tenancy (N5/D10)')

  const me = await req('recruiter', 'GET', '/api/me')
  expect('session carries tenant_id', me.data?.user?.tenant_id === 1, me.data?.user)
  expect('session carries tenant_region', typeof me.data?.user?.tenant_region === 'string', me.data?.user)

  const tenant = await req('admin', 'GET', '/api/tenant')
  expect('tenant record readable', tenant.status === 200 && tenant.data?.tenant?.id === 1, tenant.data)
  expect('tenant exposes counts', Number(tenant.data?.counts?.candidates) > 0, tenant.data?.counts)
  expect('role definitions are data', Array.isArray(tenant.data?.roles) && tenant.data.roles.length >= 7, tenant.data?.roles?.length)

  const iso = await req('admin', 'GET', '/api/tenant/isolation-check')
  expect('isolation-check runs', iso.status === 200 && Array.isArray(iso.data?.checks), iso.data)
  expect('no table has an unscoped row', iso.data?.ok === true, iso.data?.checks)

  const isoDenied = await req('recruiter', 'GET', '/api/tenant/isolation-check')
  expect('isolation-check is admin-only (403)', isoDenied.status === 403, isoDenied.data)

  /* =================================================== PHASE 2 — taxonomy */
  section('Phase 2 — governed taxonomy (N8)')

  const tax = await req('recruiter', 'GET', '/api/taxonomy')
  expect('taxonomy summary readable', tax.status === 200, tax.data)
  expect('an active version exists', tax.data?.summary?.version?.status === 'active', tax.data?.summary?.version)
  expect('12 automotive domains', (tax.data?.summary?.domains || []).length === 12, (tax.data?.summary?.domains || []).length)
  expect('taxonomy has nodes', Number(tax.data?.summary?.nodes) > 200, tax.data?.summary?.nodes)
  expect('taxonomy has weighted relations', Number(tax.data?.summary?.edges) > 200, tax.data?.summary?.edges)

  const domNodes = await req('recruiter', 'GET', '/api/taxonomy/nodes?kind=job_role')
  expect('nodes filterable by kind', domNodes.status === 200 && (domNodes.data?.nodes || []).length > 0, domNodes.data?.total)

  /* Synonym + equivalence matching is the whole point of the taxonomy. */
  const match = await req('recruiter', 'POST', '/api/taxonomy/match', {
    text: 'Strong AUTOSAR and FUSA background, HIL testing with dSPACE, BMS exposure.'
  })
  const matchedNames = (match.data?.matches || []).map((m) => m.name)
  expect('match resolves synonyms', match.status === 200 && matchedNames.length > 0, matchedNames.slice(0, 8))
  expect('"fusa" resolves to ISO 26262', matchedNames.includes('ISO 26262'), matchedNames)
  expect('"hil" resolves to HIL Testing', matchedNames.includes('HIL Testing'), matchedNames)
  expect('"bms" resolves to Battery Management Systems', matchedNames.includes('Battery Management Systems'), matchedNames)
  const viaSynonym = (match.data?.matches || []).find((m) => m.name === 'ISO 26262')
  expect('match reports HOW it matched', viaSynonym?.match === 'synonym', viaSynonym)

  /* Coverage: must-have resolution against candidate text. */
  const cov = await req('recruiter', 'POST', '/api/taxonomy/match', {
    text: 'Python, SQL and machine learning for 6 years',
    requirements: ['Python', 'SQL', 'Machine Learning', 'COBOL']
  })
  expect('coverage computed for requirements', cov.data?.coverage?.total === 4, cov.data?.coverage)
  expect('coverage counts 3 of 4 matched', cov.data?.coverage?.matched === 3, cov.data?.coverage)
  expect('unmatched requirement reported honestly', cov.data?.coverage?.gaps?.some((g) => g.requirement === 'COBOL' && !g.matched), cov.data?.coverage?.gaps)

  /* N8: a proposal does not become taxonomy. */
  const term = `Drivetrain Simulation ${RUN}`
  const proposed = await req('recruiter', 'POST', '/api/taxonomy/suggestions', { term, kind: 'technical_skill' })
  expect('suggestion queued (not live)', proposed.status === 201, proposed.data)
  const pending = await req('admin', 'GET', '/api/taxonomy/suggestions?status=pending')
  const mine = (pending.data?.suggestions || []).find((s) => s.term === term)
  expect('suggestion appears in the human queue', Boolean(mine), pending.data?.suggestions?.length)

  const beforeApprove = await req('recruiter', 'POST', '/api/taxonomy/match', { text: term })
  expect('proposed term does not match yet', (beforeApprove.data?.matches || []).length === 0, beforeApprove.data?.matches)

  const recruiterApprove = await req('recruiter', 'POST', `/api/taxonomy/suggestions/${mine?.id}/review`, { decision: 'approved' })
  expect('recruiter cannot approve taxonomy (403)', recruiterApprove.status === 403, recruiterApprove.data)

  const approved = await req('admin', 'POST', `/api/taxonomy/suggestions/${mine?.id}/review`, {
    decision: 'approved', kind: 'technical_skill', note: 'Confirmed automotive term'
  })
  expect('admin approval creates a node', approved.status === 200 && Boolean(approved.data?.nodeId), approved.data)

  const afterApprove = await req('recruiter', 'POST', '/api/taxonomy/match', { text: term })
  expect('approved term now matches', (afterApprove.data?.matches || []).length > 0, afterApprove.data?.matches)

  const doubleReview = await req('admin', 'POST', `/api/taxonomy/suggestions/${mine?.id}/review`, { decision: 'rejected' })
  expect('a suggestion cannot be reviewed twice (409)', doubleReview.status === 409, doubleReview.data)

  /* Versioning: draft -> publish, and rollback is available. */
  const draft = await req('admin', 'POST', '/api/taxonomy/versions', { notes: `Test draft ${RUN}` })
  expect('draft version created', draft.status === 201 && Number(draft.data?.version) > 1, draft.data)

  const publishDraft = await req('admin', 'POST', `/api/taxonomy/versions/${draft.data?.id}/publish`)
  expect('draft version published', publishDraft.status === 200 && publishDraft.data?.status === 'active', publishDraft.data)

  const versions = await req('admin', 'GET', '/api/taxonomy')
  const superseded = (versions.data?.versions || []).filter((v) => v.status === 'superseded')
  expect('previous version superseded, not destroyed', superseded.length >= 1, versions.data?.versions)

  const rollback = await req('admin', 'POST', `/api/taxonomy/versions/${superseded[0]?.id}/rollback`)
  expect('rollback restores a prior version', rollback.status === 200 && Boolean(rollback.data?.activeVersion), rollback.data)

  const publisherDenied = await req('coordinator', 'POST', '/api/taxonomy/versions')
  expect('coordinator cannot create versions (403)', publisherDenied.status === 403, publisherDenied.data)

  /* =================================================== PHASE 3 — evidence */
  section('Phase 3 — evidence spans (N1)')

  const extract = await req('recruiter', 'POST', '/api/resumes/64/extract')
  expect('extraction succeeds', extract.status === 200 && Number(extract.data?.stored) > 0, extract.data)
  expect('fields were verified against the source', Number(extract.data?.verified) > 0, extract.data)
  expect('experience method is stated', ['explicit', 'timeline', 'sections', 'none'].includes(extract.data?.experience?.method), extract.data?.experience)

  const fields = await req('recruiter', 'GET', '/api/resumes/64/fields')
  expect('fields readable back', fields.status === 200 && Array.isArray(fields.data?.fields), fields.data?.summary)
  const emailField = (fields.data?.fields || []).find((f) => f.field === 'email')
  expect('email extracted with a span', Boolean(emailField) && emailField.char_end > emailField.char_start, emailField)
  expect('email span is marked verified', Number(emailField?.verified) === 1, emailField)
  expect('evidence coverage reported', Number(fields.data?.summary?.evidenceCoverage) >= 0, fields.data?.summary)

  /* The verifier must reject a span that does not quote the source. */
  const lyingPreview = await req('recruiter', 'POST', '/api/evidence/preview', {
    text: 'A short document with no such claim in it at all.'
  })
  expect('preview reports unverified values honestly', Array.isArray(lyingPreview.data?.unverified), lyingPreview.data?.counts)

  /* Explicit years win; a range union is used when they do not exist. */
  const expExplicit = await req('recruiter', 'POST', '/api/evidence/preview', {
    text: 'Jane Doe\njane@example.com\nSenior Engineer with 9 years of experience in chassis design.'
  })
  expect('explicit years detected', expExplicit.data?.experience?.years === 9 && expExplicit.data?.experience?.method === 'explicit', expExplicit.data?.experience)

  const expUnion = await req('recruiter', 'POST', '/api/evidence/preview', {
    text: 'Roles held\nAcme Ltd 2018 - 2020\nBeta Corp 2019 - 2021'
  })
  expect('overlapping ranges are unioned, not summed', expUnion.data?.experience?.years === 3, expUnion.data?.experience)

  const expNone = await req('recruiter', 'POST', '/api/evidence/preview', {
    text: 'No dates and no stated experience anywhere in this text.'
  })
  expect('no evidence yields method none', expNone.data?.experience?.method === 'none' && expNone.data?.experience?.years === 0, expNone.data?.experience)

  const correct = await req('recruiter', 'POST', '/api/resumes/64/fields/experience_years', {
    value: '13', reason: 'Confirmed from the document'
  })
  expect('human correction recorded', correct.status === 200 && correct.data?.value === '13', correct.data)

  /* Coordinators hold candidate.edit, so they may correct fields; an interviewer may not. */
  const corrDenied = await req('interviewer', 'POST', '/api/resumes/64/fields/experience_years', { value: '1', reason: 'x' })
  expect('interviewer cannot correct fields (403)', corrDenied.status === 403, corrDenied.data)

  const emptyText = await req('recruiter', 'POST', '/api/evidence/preview', { text: '' })
  expect('empty text rejected (400)', emptyText.status === 400, emptyText.data)

  /* ================================================== PHASE 4 — screening */
  section('Phase 4 — screening engine (N1/N2/N3/N7)')

  const profile = await req('recruiter', 'GET', '/api/jobs/3/screening-profile')
  expect('default profile exposed with weights', profile.status === 200 && typeof profile.data?.profile?.weights === 'object', profile.data?.profile?.weights)
  const weightSum = Object.values(profile.data?.profile?.weights || {}).reduce((a, b) => a + Number(b), 0)
  expect('default weights sum to 100', Math.round(weightSum) === 100, weightSum)

  const badWeights = await req('recruiter', 'PUT', '/api/jobs/3/screening-profile', {
    weights: { must_have_coverage: 40, skills_depth: 20, experience: 18, tooling: 12, education: 5, recency: 0 }
  })
  expect('weights that do not sum to 100 rejected (422)', badWeights.status === 422, badWeights.data)

  /* N3: a profile may not weight a protected attribute. */
  const protectedWeight = await req('recruiter', 'PUT', '/api/jobs/3/screening-profile', {
    weights: { gender: 20, must_have_coverage: 40, skills_depth: 20, experience: 20, tooling: 0, education: 0, recency: 0 }
  })
  expect('protected attribute weight rejected (422)', protectedWeight.status === 422, protectedWeight.data)

  const savedProfile = await req('recruiter', 'PUT', '/api/jobs/3/screening-profile', {
    weights: { must_have_coverage: 40, skills_depth: 20, experience: 18, tooling: 12, education: 5, recency: 5 },
    knockouts: []
  })
  expect('valid profile saved as a new version', savedProfile.status === 201 && Number(savedProfile.data?.version) >= 1, savedProfile.data)

  /* Build an application for candidate 64 so the run can bind to it. */
  let appId = null
  const mkApp = await req('recruiter', 'POST', '/api/jobs/3/applications', { candidate_id: 64 })
  if (mkApp.status === 201) appId = mkApp.data?.id
  else {
    const board = await req('recruiter', 'GET', '/api/pipeline/board?job=3')
    const card = (board.data?.board?.columns || []).flatMap((c) => c.cards).find((x) => x.candidate_id === 64)
    appId = card?.id ?? null
  }
  expect('application available for screening', Boolean(appId), { mkApp: mkApp.data, appId })

  const boardBefore = await req('recruiter', 'GET', '/api/pipeline/board?job=3')
  const beforeCard = (boardBefore.data?.board?.columns || []).flatMap((c) => c.cards).find((x) => x.id === appId)

  const run = await req('recruiter', 'POST', '/api/jobs/3/screening/runs', { candidate_id: 64 })
  const r0 = run.data?.results?.[0]
  expect('screening run completes', run.status === 200 && Boolean(r0) && !r0?.error, run.data)
  expect('class is one of the seven', ['excellent', 'strong', 'good', 'partial', 'low', 'not_qualified', 'manual_review'].includes(r0?.class), r0?.class)
  expect('run is explicitly advisory', r0?.autoRejected === false, r0)
  expect('run requires a human decision', r0?.requiresHumanDecision === true, r0)
  expect('evidence was verified, not assumed', typeof r0?.evidence?.verified === 'number' && typeof r0?.evidence?.rejected === 'number', r0?.evidence)

  /* N7: the engine must not touch application state. */
  const boardAfter = await req('recruiter', 'GET', '/api/pipeline/board?job=3')
  const afterCard = (boardAfter.data?.board?.columns || []).flatMap((c) => c.cards).find((x) => x.id === appId)
  expect('screening did not move the application', beforeCard?.pipeline_stage === afterCard?.pipeline_stage, { before: beforeCard?.pipeline_stage, after: afterCard?.pipeline_stage })

  const runDetail = await req('recruiter', 'GET', `/api/screening/runs/${r0?.runId}`)
  expect('run detail readable', runDetail.status === 200 && Boolean(runDetail.data?.run), runDetail.data?.run?.id)
  expect('run detail reports human-decision state', runDetail.data?.run?.decided_at === null, runDetail.data?.run?.decided_at)
  const verifiedRows = (runDetail.data?.run?.evidence || []).filter((e) => Number(e.verified) === 1).length
  expect('stored evidence rows are all verified', verifiedRows === (runDetail.data?.run?.evidence || []).length, {
    verifiedRows, total: (runDetail.data?.run?.evidence || []).length
  })

  const decideNoReason = await req('recruiter', 'POST', `/api/screening/runs/${r0?.runId}/decide`, { decision: 'accepted' })
  expect('decision without a reason rejected (422)', decideNoReason.status === 422, decideNoReason.data)

  const decideBadClass = await req('recruiter', 'POST', `/api/screening/runs/${r0?.runId}/decide`, {
    decision: 'overridden', final_class: 'superb', reason: 'Testing an unknown class'
  })
  expect('unknown final class rejected (400)', decideBadClass.status === 400, decideBadClass.data)

  const decide = await req('recruiter', 'POST', `/api/screening/runs/${r0?.runId}/decide`, {
    decision: 'overridden', final_class: 'strong', reason: 'Verified eleven years of Python and SQL in two roles.'
  })
  expect('decision recorded with reviewer and reason', decide.status === 200 && decide.data?.machineClass === r0?.class, decide.data)

  const decideAgain = await req('recruiter', 'POST', `/api/screening/runs/${r0?.runId}/decide`, {
    decision: 'accepted', reason: 'Trying to rewrite history'
  })
  expect('a decided run cannot be decided twice (409)', decideAgain.status === 409, decideAgain.data)

  const afterDecide = await req('recruiter', 'GET', `/api/screening/runs/${r0?.runId}`)
  expect('override recorded in the run', (afterDecide.data?.run?.overrides || []).length >= 1, afterDecide.data?.run?.overrides)
  expect('oversight record written', (afterDecide.data?.run?.oversight || []).length >= 1, afterDecide.data?.run?.oversight)

  const interviewerDecide = await req('interviewer', 'POST', `/api/screening/runs/${r0?.runId}/decide`, {
    decision: 'accepted', reason: 'Interviewer should not be able to decide'
  })
  expect('interviewer cannot record a screening decision (403)', interviewerDecide.status === 403, interviewerDecide.data)

  const noResume = await req('recruiter', 'POST', '/api/jobs/3/screening/runs', { candidate_id: 1 })
  const nr = noResume.data?.results?.[0]
  expect('candidate without a resume degrades to manual_review', nr?.class === 'manual_review' || Boolean(nr?.error), nr)

  const stats = await req('recruiter', 'GET', '/api/screening/stats')
  expect('screening stats readable', stats.status === 200 && Number(stats.data?.runs) >= 1, stats.data)
  expect('human decision rate is tracked', typeof stats.data?.humanDecisionRate === 'number', stats.data?.humanDecisionRate)

  const queue = await req('recruiter', 'GET', '/api/screening/queue')
  expect('review queue readable', queue.status === 200 && Array.isArray(queue.data?.queue), queue.data?.queue?.length)

  const emptyRun = await req('recruiter', 'POST', '/api/jobs/3/screening/runs', {})
  expect('run without a candidate rejected (400)', emptyRun.status === 400, emptyRun.data)

  /* ======================================================== PHASE 5 — JD */
  section('Phase 5 — JD builder & extraction')

  const jd = await req('recruiter', 'GET', '/api/jobs/3/jd')
  expect('JD analysis readable', jd.status === 200 && Boolean(jd.data?.analysis), jd.data?.analysis?.scores)
  expect('analysis produces a quality score', typeof jd.data?.analysis?.scores?.total === 'number', jd.data?.analysis?.scores)

  const badJd = await req('recruiter', 'POST', '/api/jd/validate', {
    title: 'Junior Engineer', description: 'We need a young and energetic rockstar. Age limit 25. Marital status required.',
    requirements: 'Must have Python', must_have_skills: '["Python"]'
  })
  const codes = (badJd.data?.analysis?.issues || []).map((i) => i.code)
  expect('protected attributes flagged as errors', codes.includes('protected_attribute'), codes)
  expect('age-coded language flagged', codes.includes('discouraged_term'), codes)

  const genderJd = await req('recruiter', 'POST', '/api/jd/validate', {
    title: 'Engineer', description: 'Build things', requirements: 'x', must_have_skills: '["gender"]'
  })
  expect('protected requirement rejected', (genderJd.data?.analysis?.issues || []).some((i) => i.code === 'protected_requirement'), genderJd.data?.analysis?.issues)

  const extractReq = await req('recruiter', 'POST', '/api/jd/extract', {
    text: 'Requirements:\nMust have AUTOSAR and ISO 26262 experience\nNice to have: HIL testing with dSPACE'
  })
  expect('requirements extracted', (extractReq.data?.requirements || []).length >= 2, extractReq.data?.counts)
  expect('requirements carry source offsets', (extractReq.data?.requirements || []).every((r) => r.char_end > r.char_start), extractReq.data?.requirements?.[0])
  expect('extracted requirements resolve to taxonomy', Number(extractReq.data?.counts?.taxonomy_resolved) > 0, extractReq.data?.counts)

  const jdVersion = await req('recruiter', 'POST', '/api/jobs/3/jd/versions', { notes: `Test snapshot ${RUN}` })
  expect('JD version snapshot saved', jdVersion.status === 201 && Number(jdVersion.data?.version) >= 1, jdVersion.data)
  expect('snapshot extracts requirements', Number(jdVersion.data?.requirements) > 0, jdVersion.data?.requirements)

  const jdVersions = await req('recruiter', 'GET', '/api/jobs/3/jd')
  expect('version list includes the snapshot', (jdVersions.data?.versions || []).length >= 1, jdVersions.data?.versions?.length)

  const vIds = (jdVersions.data?.versions || []).map((v) => v.id)
  if (vIds.length >= 2) {
    const diff = await req('recruiter', 'GET', `/api/jd/diff?from=${vIds[1]}&to=${vIds[0]}`)
    expect('JD diff readable', diff.status === 200 && Array.isArray(diff.data?.added), diff.data)
  } else {
    const diffMissing = await req('recruiter', 'GET', '/api/jd/diff')
    expect('JD diff requires both version ids (400)', diffMissing.status === 400, diffMissing.data)
  }

  const jdDenied = await req('coordinator', 'POST', '/api/jobs/3/jd/versions', {})
  expect('coordinator cannot snapshot a JD (403)', jdDenied.status === 403, jdDenied.data)

  const poolCov = await req('recruiter', 'GET', '/api/jobs/3/pool-coverage')
  expect('pool coverage previews the live pool', poolCov.status === 200 && Number(poolCov.data?.coverage?.poolSize) > 0, poolCov.data?.coverage)

  /* ===================================================== PHASE 6 — pipeline */
  section('Phase 6 — 12-stage pipeline & notices')

  const board = await req('recruiter', 'GET', '/api/pipeline/board')
  expect('board renders 12 columns', (board.data?.board?.columns || []).length === 12, (board.data?.board?.columns || []).length)
  expect('no application is unassigned', board.data?.board?.unassignedCount === 0, board.data?.board?.unassigned)
  expect('funnel exposes v3.0 stages', (board.data?.funnel || []).length >= 12, (board.data?.funnel || []).length)

  const mapping = await req('recruiter', 'GET', '/api/pipeline/mapping')
  expect('legacy mapping is declared', Boolean(mapping.data?.legacyMap?.ai_screened?.stage), mapping.data?.legacyMap?.ai_screened)
  expect('terminal stages accept no moves', (mapping.data?.transitions?.joined || []).length === 0, mapping.data?.transitions?.joined)

  /* A fresh application keeps the seeded board expectations of other suites intact. */
  const newApp = await req('recruiter', 'POST', '/api/jobs/2/applications', {
    first_name: 'Pipe', last_name: `Test${RUN}`, email: `pipe.${RUN}@example.com`
  })
  expect('fixture application created', newApp.status === 201 && Boolean(newApp.data?.id), newApp.data)
  const pipeApp = newApp.data?.id

  const illegal = await req('recruiter', 'POST', `/api/applications/${pipeApp}/pipeline`, { to: 'joined' })
  expect('illegal skip to joined rejected (409)', illegal.status === 409, illegal.data)

  const unknown = await req('recruiter', 'POST', `/api/applications/${pipeApp}/pipeline`, { to: 'teleported' })
  expect('unknown stage rejected (409)', unknown.status === 409, unknown.data)

  const moveOk = await req('recruiter', 'POST', `/api/applications/${pipeApp}/pipeline`, { to: 'ai_screened' })
  expect('valid move accepted', moveOk.status === 200 && moveOk.data?.to === 'ai_screened', moveOk.data)
  expect('legacy stage derived, not free-typed', moveOk.data?.legacy?.stage === 'screening', moveOk.data?.legacy)
  expect('candidate notice issued on AI screening', Boolean(moveOk.data?.notice?.id), moveOk.data?.notice)

  const notices = await req('recruiter', 'GET', `/api/candidates/${newApp.data?.candidate_id}/notices`)
  expect('notice stored against the candidate', (notices.data?.notices || []).length >= 1, notices.data?.notices?.length)
  expect('notice states a human reviews the output', String(notices.data?.notices?.[0]?.text || '').toLowerCase().includes('human'), notices.data?.notices?.[0]?.text?.slice(0, 120))

  const ack = await req('recruiter', 'POST', `/api/notices/${moveOk.data?.notice?.id}/acknowledge`)
  expect('notice acknowledgement recorded', ack.status === 200 && ack.data?.acknowledged === true, ack.data)

  const rejectNoReason = await req('recruiter', 'POST', `/api/applications/${pipeApp}/pipeline`, { to: 'rejected' })
  expect('rejection without a reason rejected (422)', rejectNoReason.status === 422, rejectNoReason.data)

  const reject = await req('recruiter', 'POST', `/api/applications/${pipeApp}/pipeline`, {
    to: 'rejected', reason: 'Role requires Kubernetes depth not evidenced'
  })
  expect('rejection with a reason accepted', reject.status === 200 && reject.data?.to === 'rejected', reject.data)
  expect('legacy status derived for rejection', reject.data?.legacy?.status === 'rejected', reject.data?.legacy)

  const afterTerminal = await req('recruiter', 'POST', `/api/applications/${pipeApp}/pipeline`, { to: 'interview' })
  expect('terminal stage refuses further moves (409)', afterTerminal.status === 409 && afterTerminal.data?.error === 'terminal_stage', afterTerminal.data)

  const coordinatorDenied = await req('interviewer', 'POST', `/api/applications/${pipeApp}/pipeline`, { to: 'interview' })
  expect('interviewer cannot move applications (403)', coordinatorDenied.status === 403, coordinatorDenied.data)

  /* =================================================== PHASE 7 — compliance */
  section('Phase 7 — compliance pack')

  const overview = await req('admin', 'GET', '/api/compliance/overview')
  expect('compliance overview readable', overview.status === 200, overview.data)
  expect('readiness is itemised per control', (overview.data?.readiness || []).length >= 6, (overview.data?.readiness || []).length)
  expect('zero automatic rejections expected', overview.data?.oversight?.autoRejections === 0, overview.data?.oversight)
  expect('oversight compliance flag true', overview.data?.oversight?.oversightCompliant === true, overview.data?.oversight)
  expect('processors include the AI providers', (overview.data?.processors || []).length >= 3, (overview.data?.processors || []).length)

  const oversightDenied = await req('interviewer', 'GET', '/api/compliance/overview')
  expect('interviewer cannot read compliance (403)', oversightDenied.status === 403, oversightDenied.data)

  /* Adverse impact: stated numerator, denominators, small-cell suppression. */
  const impact = await req('admin', 'GET', '/api/compliance/adverse-impact')
  expect('adverse impact report computed', impact.status === 200 && Boolean(impact.data?.report), impact.data?.report?.coverage)
  expect('methodology is stated in the output', String(impact.data?.report?.methodology || '').includes('Selection'), impact.data?.report?.methodology?.slice(0, 80))
  expect('impact ratios never exceed 1', (impact.data?.report?.groups || []).every((g) => g.impact_ratio === null || g.impact_ratio <= 1), impact.data?.report?.groups)

  const impactCsv = await req('admin', 'GET', '/api/compliance/adverse-impact/export.csv')
  expect('adverse impact CSV exports', impactCsv.status === 200 && impactCsv.text.includes('impact_ratio'), impactCsv.text.slice(0, 80))

  const decideCsv = await req('admin', 'GET', '/api/compliance/decisions/export.csv')
  expect('decision log CSV exports', decideCsv.status === 200 && decideCsv.text.includes('machine_class'), decideCsv.text.slice(0, 80))
  expect('decision log includes the decided run', decideCsv.text.includes(String(r0?.runId)), decideCsv.text.slice(0, 200))

  const exportDenied = await req('interviewer', 'GET', '/api/compliance/decisions/export.csv')
  expect('interviewer cannot export decisions (403)', exportDenied.status === 403, exportDenied.data)

  const oversight = await req('admin', 'GET', '/api/compliance/oversight')
  expect('oversight log readable', oversight.status === 200 && Array.isArray(oversight.data?.log), oversight.data?.log?.length)

  /* Retention: notice before deletion, and nothing is deleted by the sweep. */
  const retention = await req('admin', 'GET', '/api/compliance/retention')
  expect('retention summary readable', retention.status === 200 && Boolean(retention.data?.policy), retention.data)

  const dryRun = await req('admin', 'POST', '/api/compliance/retention/run', { dry_run: true })
  expect('retention dry run schedules nothing', dryRun.status === 200 && Number(dryRun.data?.scheduled) === 0, dryRun.data)

  /* Breach register. */
  const breach = await req('admin', 'POST', '/api/compliance/breaches', {
    title: `Test incident ${RUN}`, severity: 'low', description: 'Automated test incident'
  })
  expect('breach logged with reference', breach.status === 201 && Boolean(breach.data?.ref), breach.data)
  expect('breach carries a response checklist', (breach.data?.checklist || []).length >= 5, breach.data?.checklist?.length)

  const breachList = await req('admin', 'GET', '/api/compliance/breaches')
  expect('breach register lists the incident', (breachList.data?.breaches || []).some((b) => b.ref === breach.data?.ref), breachList.data?.breaches?.length)

  const breachUpdate = await req('admin', 'PATCH', `/api/compliance/breaches/${breach.data?.id}`, { notified: true, closed: true })
  expect('breach can be marked notified and closed', breachUpdate.status === 200, breachUpdate.data)

  const recruiterBreach = await req('recruiter', 'POST', '/api/compliance/breaches', { title: 'nope' })
  expect('recruiter cannot log incidents (403)', recruiterBreach.status === 403, recruiterBreach.data)

  /* Processors + DPAs. */
  const processor = await req('admin', 'POST', '/api/compliance/processors', {
    name: `Test Processor ${RUN}`, role: 'processor', location: 'EU', dpa_signed: false
  })
  expect('processor record saved', processor.status === 201 && Boolean(processor.data?.id), processor.data)
  const procList = await req('admin', 'GET', '/api/compliance/processors')
  expect('processor register lists it', (procList.data?.processors || []).some((p) => p.name === `Test Processor ${RUN}`), procList.data?.processors?.length)

  /* Regions: enabling is audited and reports the safeguards it activates. */
  const regions = await req('admin', 'GET', '/api/compliance/regions')
  expect('region controls readable', regions.status === 200 && (regions.data?.regions || []).length >= 4, regions.data?.regions?.length)

  const enableEu = await req('admin', 'PATCH', '/api/compliance/regions/EU', { enabled: true })
  expect('region enable reports safeguards', enableEu.status === 200 && enableEu.data?.acknowledgementRequired === true, enableEu.data)

  const disableEu = await req('admin', 'PATCH', '/api/compliance/regions/EU', { enabled: false })
  expect('region can be disabled again', disableEu.status === 200 && disableEu.data?.enabled === false, disableEu.data)

  const regionDenied = await req('recruiter', 'PATCH', '/api/compliance/regions/EU', { enabled: true })
  expect('recruiter cannot toggle regions (403)', regionDenied.status === 403, regionDenied.data)

  /* Erasure: anonymise + retain audit, never a silent delete. */
  const victim = await req('recruiter', 'POST', '/api/jobs/5/applications', {
    first_name: 'Erase', last_name: `Me${RUN}`, email: `erase.${RUN}@example.com`
  })
  expect('erasure fixture created', victim.status === 201 && Boolean(victim.data?.candidate_id), victim.data)
  const victimId = victim.data?.candidate_id

  const eraseNoReason = await req('admin', 'POST', '/api/compliance/erasure', { candidate_id: victimId })
  expect('erasure without a reason rejected (422)', eraseNoReason.status === 422, eraseNoReason.data)

  const eraseDenied2 = await req('recruiter', 'POST', '/api/compliance/erasure', { candidate_id: victimId, reason: 'should not work' })
  expect('recruiter cannot execute erasure (403)', eraseDenied2.status === 403, eraseDenied2.data)

  const erased = await req('admin', 'POST', '/api/compliance/erasure', { candidate_id: victimId, reason: 'Data principal erasure request' })
  expect('erasure completes', erased.status === 200 && (erased.data?.steps || []).length >= 6, erased.data?.steps)
  expect('audit trail is retained, not destroyed', erased.data?.retainedAudit === true, erased.data)
  const steps = (erased.data?.steps || []).map((s) => s.step)
  expect('stop-processing is the first step', steps[0] === 'stop_processing', steps)
  expect('resume text is purged', steps.includes('purge_resume_text'), steps)
  expect('audit retention is explicit', steps.includes('retain_audit'), steps)

  const erasedAgain = await req('admin', 'POST', '/api/compliance/erasure', { candidate_id: victimId, reason: 'again' })
  expect('double erasure rejected (409)', erasedAgain.status === 409, erasedAgain.data)

  const erasedSearch = await req('recruiter', 'GET', `/api/candidates/${victimId}/notices`)
  expect('erased candidate record survives for audit', erasedSearch.status === 200, erasedSearch.status)

  const history = await req('admin', 'GET', `/api/compliance/erasure/${victimId}`)
  expect('erasure step history readable', history.status === 200 && (history.data?.steps || []).length >= 6, history.data?.steps?.length)

  /* ============================================================ Summary */
  section('Result')
  const total = pass + failures.length
  console.log(`\n  ${pass}/${total} passed`)
  if (failures.length) {
    console.log(`\n  \x1b[31mFailures:\x1b[0m`)
    failures.forEach((f) => console.log(`   · ${f}`))
    process.exit(1)
  }
  console.log('  \x1b[32mAll phase acceptance tests passed.\x1b[0m')
}

main().catch((e) => { console.error(e); process.exit(1) })
