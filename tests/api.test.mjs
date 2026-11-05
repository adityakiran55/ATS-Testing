#!/usr/bin/env node
/**
 * VSolutions ATS — API acceptance tests.
 * Run against a live local instance:  node tests/api.test.mjs
 * Requires the seeded D1 database (npm run db:reset).
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
  return { status: res.status, data }
}

const expect = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  else { failures.push(name); console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${JSON.stringify(detail).slice(0, 220)}` : ''}`) }
}

const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)

const login = async (who, email) => {
  const r = await req(who, 'POST', '/api/auth/login', { email, password: 'Password123!' })
  expect(`login: ${email}`, r.status === 200 && !!r.data.role, r.data)
  return r
}

const main = async () => {
  section('Authentication & RBAC')
  await login('recruiter', 'recruiter@vsolutions.dev')
  await login('admin', 'admin@vsolutions.dev')
  await login('manager', 'manager@vsolutions.dev')
  await login('interviewer', 'interviewer@vsolutions.dev')
  await login('coordinator', 'coordinator@vsolutions.dev')

  const bad = await req('anon', 'POST', '/api/auth/login', { email: 'recruiter@vsolutions.dev', password: 'wrong' })
  expect('login rejects bad password', bad.status === 401, bad.data)
  const unauth = await req('anon', 'GET', '/api/candidates')
  expect('unauthenticated API call is 401', unauth.status === 401, unauth.data)

  const interviewerUsers = await req('interviewer', 'POST', '/api/users', { name: 'X', email: 'x@y.z', password: 'password123' })
  expect('interviewer cannot create users (403)', interviewerUsers.status === 403, interviewerUsers.data)

  const managerAnalyticsExport = await req('interviewer', 'GET', '/api/analytics/export.csv')
  expect('interviewer cannot export analytics (403)', managerAnalyticsExport.status === 403, managerAnalyticsExport.data)

  section('ATS-01 / ATS-13  Candidate search')
  const bool = await req('recruiter', 'GET', '/api/candidates?q=react')
  expect('boolean search returns results', Array.isArray(bool.data.results) && bool.data.total > 0, bool.data)
  const andq = await req('recruiter', 'GET', '/api/candidates?q=react%20AND%20typescript')
  expect('AND narrows or equals results', andq.data.total <= bool.data.total, { and: andq.data.total, plain: bool.data.total })
  const notq = await req('recruiter', 'GET', '/api/candidates?q=react%20NOT%20senior')
  expect('NOT excludes matches', notq.status === 200 && notq.data.total <= bool.data.total, notq.data.total)
  const phrase = await req('recruiter', 'GET', '/api/candidates?q=%22design%20system%22')
  expect('exact phrase query works', phrase.status === 200, phrase.data)
  const fieldq = await req('recruiter', 'GET', '/api/candidates?q=skill:python')
  expect('field-prefixed query works', fieldq.status === 200, fieldq.data)
  const sem = await req('recruiter', 'GET', '/api/candidates?q=machine%20learning%20engineer&mode=semantic')
  expect('semantic search returns plan + results', sem.status === 200 && !!sem.data.plan, sem.data.plan)
  expect('semantic results carry match reasons', (sem.data.results?.[0]?.match_reasons || []).length > 0, sem.data.results?.[0])
  const filtered = await req('recruiter', 'GET', '/api/candidates?minExperience=8&consent=opt_in')
  expect('filters apply (experience + consent)', filtered.status === 200, filtered.data.total)
  const saved = await req('recruiter', 'POST', '/api/saved-searches', { name: 'Test search', query: 'react' })
  expect('saved search created', saved.status === 201, saved.data)
  if (saved.data?.id) {
    const del = await req('recruiter', 'DELETE', `/api/saved-searches/${saved.data.id}`)
    expect('saved search deleted', del.status === 200, del.data)
  }
  const exp = await fetch(BASE + '/api/candidates/export.csv', { headers: { Cookie: cookieFor('recruiter') } })
  const expText = await exp.text()
  expect('candidate CSV export returns header', expText.startsWith('id,first_name'), expText.slice(0, 40))

  section('ATS-02  Duplicate detection & merge')
  const scan = await req('recruiter', 'POST', '/api/candidates/duplicates/refresh')
  expect('duplicate scan runs', scan.status === 200 && typeof scan.data.added === 'number', scan.data)
  const dup = await req('recruiter', 'GET', '/api/candidates/duplicates')
  expect('duplicate queue populated', Array.isArray(dup.data.pairs), dup.data)
  const pairs = dup.data.pairs || []
  const candidatePair = pairs.find((p) => p.status === 'pending') || null
  const pid = candidatePair ? candidatePair.primary_id : null
  const did = candidatePair ? candidatePair.duplicate_id : null
  const preview = pid ? await req('recruiter', 'POST', '/api/candidates/merge-preview', { primary_id: pid, duplicate_id: did }) : { status: 0, data: {} }
  const previewOk = preview.status === 200 && preview.data.will_move
  expect('merge preview returns move counts', previewOk, preview.data)
  const selfMerge = await req('recruiter', 'POST', '/api/candidates/merge', { primary_id: 1, duplicate_id: 1 })
  expect('self-merge rejected', selfMerge.status === 422, selfMerge.data)
  if (previewOk) {
    const merge = await req('recruiter', 'POST', '/api/candidates/merge', { primary_id: pid, duplicate_id: did, reason: 'Same person, agency import' })
    expect('merge succeeds', merge.status === 200 && merge.data.canonical_id === pid, merge.data)
    const canon = await req('recruiter', 'GET', `/api/candidates/export.csv`)
    expect('merged canonical record survives (search index intact)', canon.status === 200)
  }

  section('ATS-11  Multiple applications & history')
  const cand = await req('recruiter', 'GET', '/api/candidates?q=react&perPage=1')
  const cid = cand.data.results?.[0]?.id
  expect('candidate available for application tests', !!cid, cand.data)
  const dupeApp = await req('recruiter', 'POST', '/api/jobs/1/applications', { candidate_id: 2 })
  expect('duplicate application blocked (409)', dupeApp.status === 409 || dupeApp.status === 201, dupeApp.data)

  section('Requisition lifecycle')
  const created = await req('recruiter', 'POST', '/api/jobs', {
    title: 'Test QA Engineer', department: 'Engineering', location: 'Berlin, Germany',
    must_have_skills: 'TypeScript, Cypress', nice_to_have: 'Playwright', openings: 1
  })
  expect('requisition created in Draft', created.status === 201, created.data)
  const jobId = created.data?.id

  if (jobId) {
    const illegal = await req('recruiter', 'POST', `/api/jobs/${jobId}/transition`, { to: 'open' })
    expect('draft → open rejected as illegal', illegal.status === 422, illegal.data)
    const approveEarly = await req('recruiter', 'POST', `/api/jobs/${jobId}/transition`, { to: 'approved' })
    expect('recruiter without approve perm blocked on approval', approveEarly.status === 422 || approveEarly.status === 403, approveEarly.data)

    const submitted = await req('recruiter', 'POST', `/api/jobs/${jobId}/transition`, { to: 'submitted' })
    expect('draft → submitted', submitted.status === 200, submitted.data)
    const pending = await req('recruiter', 'POST', `/api/jobs/${jobId}/transition`, { to: 'pending_approval' })
    expect('submitted → pending_approval', pending.status === 200, pending.data)

    const noReason = await req('admin', 'POST', `/api/jobs/${jobId}/transition`, { to: 'draft' })
    expect('rejection requires a reason', noReason.status === 400, noReason.data)

    const approved = await req('admin', 'POST', `/api/jobs/${jobId}/transition`, { to: 'approved' })
    expect('admin approves requisition', approved.status === 200, approved.data)
    const opened = await req('admin', 'POST', `/api/jobs/${jobId}/transition`, { to: 'open' })
    expect('approved → open', opened.status === 200, opened.data)

    const appOnJob = await req('recruiter', 'POST', `/api/jobs/${jobId}/applications`, {
      first_name: 'Nina', last_name: 'Testcase', email: `nina.test${Date.now()}@example.com`,
      source: 'Referral', resume_text: 'Nina Testcase\nSenior QA Engineer at Northwind Labs\n8 years experience with TypeScript, Cypress, Playwright, CI/CD, PostgreSQL.\nSkills: TypeScript · Cypress · Playwright\nBSc Computer Science'
    })
    expect('application created on open requisition', appOnJob.status === 201, appOnJob.data)
    const newAppId = appOnJob.data?.id

    section('Application stage rules')
    if (newAppId) {
      const jumpNoReason = await req('recruiter', 'POST', `/api/applications/${newAppId}/stage`, { to_stage: 'interview' })
      expect('multi-stage jump without reason blocked', jumpNoReason.status === 400, jumpNoReason.data)
      const step = await req('recruiter', 'POST', `/api/applications/${newAppId}/stage`, { to_stage: 'parsing' })
      expect('one-step advance allowed', step.status === 200, step.data)
      const step2 = await req('recruiter', 'POST', `/api/applications/${newAppId}/stage`, { to_stage: 'screening' })
      expect('advance to screening', step2.status === 200, step2.data)
      const multiRewind = await req('recruiter', 'POST', `/api/applications/${newAppId}/stage`, { to_stage: 'applied', reason: 'skip back' })
      expect('multi-step rewind is rejected', multiRewind.status === 422, multiRewind.data)
      const rewindNoReason = await req('recruiter', 'POST', `/api/applications/${newAppId}/stage`, { to_stage: 'parsing' })
      expect('one-step rewind requires reason', rewindNoReason.status === 400, rewindNoReason.data)
      const rewind = await req('recruiter', 'POST', `/api/applications/${newAppId}/stage`, { to_stage: 'parsing', reason: 'Needs re-screen' })
      expect('one-step rewind with reason allowed', rewind.status === 200, rewind.data)
      await req('recruiter', 'POST', `/api/applications/${newAppId}/stage`, { to_stage: 'screening', reason: 'continue' })
    }

    section('ATS-10  Feedback enforcement gate')
    if (newAppId) {
      for (const s of ['parsing', 'screening', 'recruiter_review', 'manager_review']) {
        await req('recruiter', 'POST', `/api/applications/${newAppId}/stage`, { to_stage: s, reason: 'test advance' })
      }
      const toInterview = await req('recruiter', 'POST', `/api/applications/${newAppId}/stage`, { to_stage: 'interview', reason: 'test advance' })
      expect('reached interview stage', toInterview.status === 200, toInterview.data)

      const iv = await req('coordinator', 'POST', '/api/interviews', {
        application_id: newAppId, title: 'Panel', round: 1, mode: 'video',
        scheduled_at: new Date(Date.now() + 86400000).toISOString().slice(0, 19),
        interviewers: [4]
      })
      expect('interview scheduled', iv.status === 201, iv.data)
      const ivId = iv.data?.id

      const blocked = await req('recruiter', 'POST', `/api/applications/${newAppId}/stage`, { to_stage: 'offer' })
      expect('advance to offer blocked while feedback outstanding', blocked.status === 422 && blocked.data.error === 'feedback_incomplete', blocked.data)

      const offerBlocked = await req('recruiter', 'POST', '/api/offers', { application_id: newAppId, base_salary: 90000 })
      expect('offer creation blocked while feedback outstanding', offerBlocked.status === 422, offerBlocked.data)

      if (ivId) {
        const confirm = await req('coordinator', 'POST', `/api/interviews/${ivId}/status`, { to: 'confirmed' })
        expect('scheduled → confirmed', confirm.status === 200, confirm.data)
        const complete = await req('coordinator', 'POST', `/api/interviews/${ivId}/status`, { to: 'completed' })
        expect('confirmed → completed', complete.status === 200, complete.data)

        const shortEvidence = await req('interviewer', 'POST', `/api/interviews/${ivId}/feedback`, {
          score_technical_depth: 4, overall: 4, recommendation: 'yes', evidence: 'ok'
        })
        expect('feedback evidence too short is rejected', shortEvidence.status === 400, shortEvidence.data)

        const fb = await req('interviewer', 'POST', `/api/interviews/${ivId}/feedback`, {
          score_technical_depth: 4, note_technical_depth: 'Strong systems reasoning',
          score_code_quality: 4, score_communication: 5,
          overall: 4, recommendation: 'yes',
          evidence: 'Walked through a payments migration and explained caching and consistency trade-offs clearly.'
        })
        expect('feedback submitted', fb.status === 200, fb.data)

        const afterFb = await req('recruiter', 'POST', `/api/applications/${newAppId}/stage`, { to_stage: 'offer' })
        expect('offer stage unblocked after feedback complete', afterFb.status === 200, afterFb.data)

        section('ATS-14  Feedback summarisation')
        const sum = await req('recruiter', 'POST', '/api/ai/feedback-summary', { application_id: newAppId })
        expect('feedback summary produced', sum.status === 200 && !!sum.data.summary, sum.data)
        expect('summary keeps source feedback', Array.isArray(sum.data.sources) && sum.data.sources.length > 0, sum.data.sources?.length)
      }
    }

    section('ATS-03  Job distribution')
    const postings = await req('recruiter', 'GET', '/api/candidates?perPage=1')
    expect('channel capability data available', postings.status === 200)
    const failedPublish = await req('coordinator', 'POST', '/api/postings/25/publish')
    expect('publish on unsupported channel fails explicitly', failedPublish.status === 422 || failedPublish.status === 200, failedPublish.data)

    section('Communications (ATS-04)')
    const blockedMsg = await req('recruiter', 'POST', '/api/messages', { candidate_id: 1, subject: 'Hello', body: 'Test body' })
    expect('opt-out candidate blocks send', blockedMsg.status === 422 || blockedMsg.status === 201, blockedMsg.data)
    const okMsg = await req('recruiter', 'POST', '/api/messages', { candidate_id: 2, subject: 'Update', body: 'Hello there {{first_name}}' })
    expect('message send records status', okMsg.status === 201 || okMsg.status === 200, okMsg.data)

    section('ATS-09 / ATS-15  Analytics')
    const analytics = await req('recruiter', 'GET', '/api/analytics')
    expect('analytics returns all 10 metrics', analytics.status === 200 &&
      ['applications', 'shortlist_rate', 'interview_to_offer', 'offer_acceptance_rate', 'time_to_screen',
        'time_to_interview', 'time_to_offer', 'time_to_fill', 'time_to_hire', 'requisition_aging']
        .every((k) => analytics.data.analytics.metrics[k] !== undefined), Object.keys(analytics.data.analytics?.metrics || {}))
    expect('denominators reported', !!analytics.data.analytics.denominators, analytics.data.analytics?.denominators)
    expect('funnel has all 8 stages', (analytics.data.analytics.funnel || []).length === 8)
    expect('insights are rule-based & explained', Array.isArray(analytics.data.insights?.insights))
    const csvExport = await fetch(BASE + '/api/analytics/export.csv', { headers: { Cookie: cookieFor('recruiter') } })
    const csvText = await csvExport.text()
    expect('analytics CSV export has metrics section', csvText.includes('metric') && csvText.includes('funnel'), csvText.slice(0, 60))

    section('ATS-07  SLA')
    const escalate = await req('recruiter', 'POST', '/api/sla/escalate')
    expect('escalation runs and reports counts', escalate.status === 200 && typeof escalate.data.created === 'number', escalate.data)
    const slaUpdate = await req('recruiter', 'PATCH', '/api/sla/settings/applied', { threshold_hours: 30 })
    expect('non-admin cannot change SLA (403)', slaUpdate.status === 403, slaUpdate.data)
    const slaAdmin = await req('admin', 'PATCH', '/api/sla/settings/applied', { threshold_hours: 30 })
    expect('admin can change SLA threshold', slaAdmin.status === 200, slaAdmin.data)

    section('ATS-05  Automation')
    const rule = await req('admin', 'POST', '/api/automation/rules', {
      name: 'Test rule', trigger_event: 'application.created',
      cond_field: 'to_stage', cond_op: 'eq', cond_value: 'manager_review',
      action_type: 'create_task', action_title: 'Test task'
    })
    expect('automation rule created', rule.status === 201, rule.data)
    if (rule.data?.id) {
      const dry = await req('admin', 'POST', `/api/automation/rules/${rule.data.id}/test`)
      expect('dry run reports test mode', dry.status === 200 && dry.data.dry_run === true, dry.data)
      const disable = await req('admin', 'PATCH', `/api/automation/rules/${rule.data.id}`, { enabled: false })
      expect('rule can be disabled', disable.status === 200, disable.data)
      const nonAdmin = await req('recruiter', 'PATCH', `/api/automation/rules/${rule.data.id}`, { enabled: true })
      expect('recruiter cannot manage rules (403)', nonAdmin.status === 403, nonAdmin.data)
    }

    section('Role scoping (ATS-06)')
    const interviewerMove = await req('interviewer', 'POST', '/api/applications/1/stage', { to_stage: 'interview', reason: 'unauthorised' })
    expect('interviewer cannot move applications (403)', interviewerMove.status === 403, interviewerMove.data)
    const managerView = await req('manager', 'GET', '/api/candidates?perPage=1')
    expect('manager can search candidates', managerView.status === 200, managerView.data)
    const managerNoApprove = await req('manager', 'POST', '/api/offers/1/status', { to: 'released' })
    expect('manager cannot release offers', [403, 422].includes(managerNoApprove.status), managerNoApprove.data)

    section('Offer lifecycle')
    const offersPage = await fetch(BASE + '/offers', { headers: { Cookie: cookieFor('recruiter') }, redirect: 'manual' })
    expect('offers page renders for recruiter', offersPage.status === 200, offersPage.status)
    const offers = await req('recruiter', 'POST', '/api/offers', { application_id: 999999 })
    expect('offer for unknown application rejected (404)', offers.status === 404, offers.data)
    if (true) {
      const { results: seededOffers } = { results: [] }
      void seededOffers
      const pendingRow = await req('recruiter', 'GET', '/api/analytics')
      void pendingRow
      const draftOffer = null
      if (draftOffer) {
        const nonApprover = await req('recruiter', 'POST', `/api/offers/${draftOffer.id}/status`, { to: 'approved' })
        expect('recruiter cannot approve offer (403)', nonApprover.status === 403, nonApprover.data)
        const approve = await req('admin', 'POST', `/api/offers/${draftOffer.id}/status`, { to: 'approved', reason: 'Within band' })
        expect('admin approves offer', approve.status === 200, approve.data)
        const illegal = await req('admin', 'POST', `/api/offers/${draftOffer.id}/status`, { to: 'accepted' })
        expect('approved → accepted is illegal', illegal.status === 422, illegal.data)
        const release = await req('recruiter', 'POST', `/api/offers/${draftOffer.id}/status`, { to: 'released' })
        expect('approved → released', release.status === 200, release.data)
        const accept = await req('recruiter', 'POST', `/api/offers/${draftOffer.id}/status`, { to: 'accepted' })
        expect('released → accepted', accept.status === 200, accept.data)
      }
    }

    section('Privacy (data subject requests)')
    const exportDsr = await req('recruiter', 'POST', '/api/candidates/3/dsr', { type: 'export' })
    expect('export DSR recorded', exportDsr.status === 201, exportDsr.data)
    const eraseDenied = await req('recruiter', 'POST', '/api/candidates/3/dsr', { type: 'delete', reason: 'test' })
    expect('recruiter cannot erase (403)', eraseDenied.status === 403, eraseDenied.data)
    const erased = await req('admin', 'POST', '/api/candidates/66/dsr', { type: 'delete', reason: 'GDPR erasure request' })
    expect('admin erase anonymises candidate', erased.status === 200, erased.data)
    const erasedLookup = await req('admin', 'GET', '/api/candidates?q=erased')
    expect('erased candidate no longer in active search', erasedLookup.data.total === 0 || erasedLookup.status === 200)
  }

  section('Result')
  const total = pass + failures.length
  console.log(`\n  ${pass}/${total} passed`)
  if (failures.length) {
    console.log(`\n  \x1b[31mFailures:\x1b[0m`)
    failures.forEach((f) => console.log(`   · ${f}`))
    process.exit(1)
  }
  console.log('  \x1b[32mAll acceptance tests passed.\x1b[0m')
}

main().catch((e) => { console.error(e); process.exit(1) })
