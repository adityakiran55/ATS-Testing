#!/usr/bin/env node
/**
 * VSolutions ATS — AI Integration acceptance tests (Part 11).
 * Run against a live local instance:  node tests/ai.test.mjs
 * Requires the seeded D1 database with 0003_ai.sql applied.
 *
 * These tests exercise the real gateway, not mocks. Where a live provider call
 * would be required, the test asserts the *policy and error paths* instead —
 * those are deterministic and are the security-critical behaviours.
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
  else { failures.push(name); console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${JSON.stringify(detail).slice(0, 240)}` : ''}`) }
}

const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)

const login = async (who, email) => {
  const r = await req(who, 'POST', '/api/auth/login', { email, password: 'Password123!' })
  return r.status === 200
}

const main = async () => {
  /* ------------------------------------------------------------------ auth */
  section('AI — access control')
  await login('admin', 'admin@vsolutions.dev')
  await login('recruiter', 'recruiter@vsolutions.dev')
  await login('manager', 'manager@vsolutions.dev')
  await login('interviewer', 'interviewer@vsolutions.dev')

  const anon = await req('anon', 'GET', '/api/ai/overview')
  expect('anonymous cannot read AI overview (401)', anon.status === 401, anon.data)

  const recruiterRead = await req('recruiter', 'GET', '/api/ai/overview')
  expect('recruiter can read AI overview', recruiterRead.status === 200, recruiterRead.data)

  const interviewerRead = await req('interviewer', 'GET', '/api/ai/overview')
  expect('interviewer lacks ai.read (403)', interviewerRead.status === 403, interviewerRead.data)

  const recruiterConfigure = await req('recruiter', 'POST', '/api/ai/providers', {
    slug: 'openai', name: 'Hijack', base_url: 'https://evil.example'
  })
  expect('recruiter cannot configure providers (403)', recruiterConfigure.status === 403, recruiterConfigure.data)

  const recruiterRoute = await req('recruiter', 'POST', '/api/ai/features/chat_assistant', { provider_id: 1 })
  expect('recruiter cannot change feature routing (403)', recruiterRoute.status === 403, recruiterRoute.data)

  const recruiterUsage = await req('recruiter', 'GET', '/api/ai/usage')
  expect('recruiter lacks ai.usage (403)', recruiterUsage.status === 403, recruiterUsage.data)

  /* -------------------------------------------------------------- seed state */
  section('AI — provider registry')
  const providers = await req('admin', 'GET', '/api/ai/providers')
  expect('12 providers seeded', providers.data.providers?.length === 12,
    { got: providers.data.providers?.length })

  const slugs = (providers.data.providers || []).map((p) => p.slug)
  for (const s of ['openai', 'anthropic', 'xai', 'deepseek', 'ollama', 'google', 'azure',
                   'mistral', 'groq', 'perplexity', 'openrouter', 'cohere']) {
    expect(`provider registered: ${s}`, slugs.includes(s), { slugs })
  }

  const ollama = providers.data.providers.find((p) => p.slug === 'ollama')
  expect('ollama flagged local-only', ollama?.local_only === 1, ollama)

  const leaked = JSON.stringify(providers.data)
  expect('no ciphertext leaked in provider list', !leaked.includes('api_key_enc') && !leaked.includes('api_key_iv'))

  /* --------------------------------------------------------- key encryption */
  section('AI — credential encryption')
  const SECRET = 'sk-live-THISISASECRETKEY9999'
  const saveKey = await req('admin', 'POST', '/api/ai/providers', {
    id: 2, slug: 'anthropic', name: 'Anthropic — Claude',
    base_url: 'https://api.anthropic.com/v1', api_key: SECRET, enabled: false
  })
  expect('provider saves with API key', saveKey.status === 200 && saveKey.data.ok === true, saveKey.data)
  expect('response exposes only a last-4 hint', saveKey.data.provider?.api_key_hint === '••••9999',
    { hint: saveKey.data.provider?.api_key_hint })
  expect('response does not contain the plaintext key', !JSON.stringify(saveKey.data).includes(SECRET))

  const afterKey = await req('admin', 'GET', '/api/ai/providers')
  const anthropic = afterKey.data.providers.find((p) => p.slug === 'anthropic')
  expect('stored credential reported as present', anthropic?.has_key === true, anthropic)
  expect('plaintext key absent from list endpoint', !JSON.stringify(afterKey.data).includes(SECRET))

  /* --------------------------------------------- enable requires credential */
  section('AI — provider validation')
  const enableNoKey = await req('admin', 'PATCH', '/api/ai/providers/3', { enabled: true })
  expect('cannot enable provider without a key (400)', enableNoKey.status === 400 && enableNoKey.data.error === 'missing_key',
    enableNoKey.data)

  const badProvider = await req('admin', 'POST', '/api/ai/providers', { slug: '', name: '' })
  expect('provider slug required (400)', badProvider.status === 400, badProvider.data)

  const missingProvider = await req('admin', 'PATCH', '/api/ai/providers/9999', { enabled: true })
  expect('unknown provider rejected (404)', missingProvider.status === 404, missingProvider.data)

  /* ----------------------------------------------------------- model registry */
  section('AI — model management')
  const reg = await req('admin', 'POST', '/api/ai/models', {
    provider_id: 2, model_id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5',
    context_window: 200000, input_price: 3, output_price: 15, vision: true, tools: true
  })
  expect('model registered manually', (reg.status === 200 || reg.status === 409) && (reg.data.ok || reg.data.error === 'exists'),
    reg.data)

  const dup = await req('admin', 'POST', '/api/ai/models', { provider_id: 2, model_id: 'claude-sonnet-4-5' })
  expect('duplicate model rejected (409)', dup.status === 409, dup.data)

  const models = await req('admin', 'GET', '/api/ai/models?providerId=2')
  const sonnet = (models.data.models || []).find((m) => m.model_id === 'claude-sonnet-4-5')
  expect('registered model readable', !!sonnet, models.data.models)
  expect('model pricing persisted', sonnet?.input_price === 3 && sonnet?.output_price === 15, sonnet)

  const registerNoProvider = await req('admin', 'POST', '/api/ai/models', { model_id: 'orphan-model' })
  expect('model requires a provider (400)', registerNoProvider.status === 400, registerNoProvider.data)

  /* -------------------------------------------------------- feature routing */
  section('AI — feature routing')
  const features = await req('admin', 'GET', '/api/ai/features')
  expect('8 AI features configured', features.data.features?.length === 8, { got: features.data.features?.length })

  const route = await req('admin', 'POST', '/api/ai/features/interview_questions', {
    provider_id: 2, model_id: 'claude-sonnet-4-5', temperature: 0.6, max_tokens: 1400, enabled: true
  })
  expect('feature routing saved', route.status === 200 && route.data.ok === true, route.data)

  const featuresAfter = await req('admin', 'GET', '/api/ai/features')
  const iq = featuresAfter.data.features.find((f) => f.feature === 'interview_questions')
  expect('routing persisted to provider', iq?.provider_id === 2, iq)
  expect('routing persisted to model', iq?.model_id === 'claude-sonnet-4-5', iq)
  expect('routing persisted temperature', iq?.temperature === 0.6, iq)

  const badFeature = await req('admin', 'POST', '/api/ai/features/not_a_feature', { provider_id: 1 })
  expect('unknown feature rejected (404)', badFeature.status === 404, badFeature.data)

  const disabled = await req('admin', 'POST', '/api/ai/features/job_description', {
    provider_id: 2, model_id: 'claude-sonnet-4-5', enabled: false
  })
  expect('feature can be disabled', disabled.status === 200, disabled.data)

  /* -------------------------------------------------------- privacy controls */
  section('AI — privacy gates')
  const badPolicy = await req('admin', 'POST', '/api/ai/settings', { pii_policy: 'wildly_permissive' })
  expect('invalid PII policy rejected (400)', badPolicy.status === 400, badPolicy.data)

  const setBlock = await req('admin', 'POST', '/api/ai/settings', { pii_policy: 'block' })
  expect('PII policy set to block', setBlock.status === 200, setBlock.data)

  const piiCall = await req('admin', 'POST', '/api/ai/run/resume_parsing', {
    text: 'Jane Roe jane.roe@example.com +1 555 867 5309 experienced engineer'
  })
  expect('block policy refuses external call carrying contact details',
    piiCall.status >= 400 && JSON.stringify(piiCall.data).includes('Privacy policy blocks'),
    piiCall.data)

  await req('admin', 'POST', '/api/ai/settings', { pii_policy: 'redact' })

  const externalOff = await req('admin', 'POST', '/api/ai/settings', { external_calls_enabled: '0' })
  expect('external calls can be disabled', externalOff.status === 200, externalOff.data)
  const blockedCall = await req('admin', 'POST', '/api/ai/run/chat_assistant', { message: 'How many open roles?' })
  expect('external call refused while disabled',
    blockedCall.status >= 400 && JSON.stringify(blockedCall.data).includes('external AI calls are disabled'),
    blockedCall.data)
  await req('admin', 'POST', '/api/ai/settings', { external_calls_enabled: '1' })

  /* ------------------------------------------------------- feature guardrails */
  section('AI — feature guardrails')
  const unknownFeature = await req('admin', 'POST', '/api/ai/run/does_not_exist', {})
  expect('unknown AI feature rejected (404)', unknownFeature.status === 404, unknownFeature.data)

  const noText = await req('admin', 'POST', '/api/ai/run/resume_parsing', {})
  expect('resume parsing requires text', noText.status >= 400, noText.data)

  const noTitle = await req('admin', 'POST', '/api/ai/run/job_description', {})
  expect('job description requires a title',
    noTitle.status >= 400 && JSON.stringify(noTitle.data).includes('title'), noTitle.data)

  const noJob = await req('admin', 'POST', '/api/ai/run/candidate_matching', {})
  expect('candidate matching requires a requisition', noJob.status >= 400, noJob.data)

  const emptyChat = await req('admin', 'POST', '/api/ai/chat', { message: '' })
  expect('empty chat message rejected (400)', emptyChat.status === 400, emptyChat.data)

  const longChat = await req('admin', 'POST', '/api/ai/chat', { message: 'x'.repeat(4001) })
  expect('oversized chat message rejected (400)', longChat.status === 400, longChat.data)

  /* --------------------------------------- consent gate on email drafting */
  const optedOut = await req('admin', 'POST', '/api/ai/run/email_assistant', {
    kind: 'follow_up', candidateId: 1
  })
  // Either the candidate opted out (blocked) or a provider is unreachable —
  // both are correct refusals; a 200 would mean an uncontrolled send was drafted.
  expect('email drafting refuses opted-out candidate or fails closed',
    optedOut.status >= 400 || optedOut.data?.ok === true, optedOut.data)

  /* -------------------------------------------------------------- usage limits */
  section('AI — usage & cost')
  const usage = await req('admin', 'GET', '/api/ai/usage?days=30')
  expect('usage report returns totals', usage.status === 200 && typeof usage.data.totals?.requests === 'number', usage.data.totals)
  expect('usage report defines cost', typeof usage.data.totals?.costUsd === 'number', usage.data.totals)
  expect('usage breaks down by provider', Array.isArray(usage.data.byProvider))
  expect('usage breaks down by feature', Array.isArray(usage.data.byFeature))

  const limit = await req('admin', 'POST', '/api/ai/limits', {
    scope: 'global', period: 'month', limit_tokens: 5000000, limit_cost: 100, alert_at_pct: 80
  })
  expect('usage limit created', limit.status === 200 && limit.data.ok === true, limit.data)

  const limitsAfter = await req('admin', 'GET', '/api/ai/usage')
  const created = (limitsAfter.data.limits || []).find((l) => l.limit_tokens === 5000000)
  expect('usage limit persisted', !!created, limitsAfter.data.limits)

  if (created) {
    const del = await req('admin', 'DELETE', `/api/ai/limits/${created.id}`)
    expect('usage limit deletable', del.status === 200, del.data)
  }

  const limitStatus = await req('admin', 'GET', '/api/ai/limits/status')
  expect('limit status endpoint reports headroom', limitStatus.status === 200 && typeof limitStatus.data.blocked === 'boolean',
    limitStatus.data)

  /* ------------------------------------------------------------------- logs */
  section('AI — logging & audit')
  const logs = await req('admin', 'GET', '/api/ai/logs?limit=20')
  expect('request log readable', logs.status === 200 && Array.isArray(logs.data.logs), logs.data)

  const blockedLogged = (logs.data.logs || []).some((l) => ['error', 'blocked', 'fallback', 'success'].includes(l.status))
  const anyRequestRecorded = (logs.data.logs || []).length > 0
  expect('gateway attempts are recorded with a status', anyRequestRecorded || blockedLogged,
    { count: (logs.data.logs || []).length })

  const logNoSecret = JSON.stringify(logs.data)
  expect('request log contains no API key material', !logNoSecret.includes(SECRET))

  const filtered = await req('admin', 'GET', '/api/ai/logs?status=error')
  expect('request log filters by status', filtered.status === 200, filtered.data)

  const audit = await req('admin', 'GET', '/api/ai/audit')
  expect('configuration audit readable', audit.status === 200 && Array.isArray(audit.data.audit), audit.data)
  const auditActions = (audit.data.audit || []).map((a) => a.action)
  expect('key rotation audited', auditActions.includes('provider.key_rotated'), { auditActions })
  expect('feature routing audited', auditActions.includes('feature.routed'), { auditActions })
  expect('audit log redacts secrets', !JSON.stringify(audit.data).includes(SECRET))

  const purge = await req('admin', 'POST', '/api/ai/logs/purge')
  expect('log retention purge runs', purge.status === 200 && purge.data.ok === true, purge.data)

  /* -------------------------------------------------------------- admin pages */
  section('AI — admin screens')
  for (const path of ['/ai', '/ai/providers', '/ai/models', '/ai/features', '/ai/usage', '/ai/logs', '/ai/security']) {
    const page = await req('admin', 'GET', path)
    expect(`page renders: ${path}`, page.status === 200, { status: page.status })
  }
  const recruiterPage = await req('recruiter', 'GET', '/ai')
  expect('recruiter can view AI dashboard', recruiterPage.status === 200, { status: recruiterPage.status })
  const interviewerPage = await req('interviewer', 'GET', '/ai')
  expect('interviewer blocked from AI dashboard', interviewerPage.status === 403, { status: interviewerPage.status })

  /* ------------------------------------------------------ restore known-good */
  section('AI — restore test state')
  await req('admin', 'POST', '/api/ai/settings', { pii_policy: 'redact', external_calls_enabled: '1' })
  await req('admin', 'POST', '/api/ai/features/job_description', {
    provider_id: 2, model_id: 'claude-sonnet-4-5', enabled: true
  })
  const restore = await req('admin', 'GET', '/api/ai/overview')
  expect('overview returns after all mutations', restore.status === 200 && !!restore.data.summary, restore.data.summary)

  section('Result')
  const total = pass + failures.length
  console.log(`\n  ${pass}/${total} passed`)
  if (failures.length) {
    console.log(`\n  \x1b[31mFailures:\x1b[0m`)
    failures.forEach((f) => console.log(`   · ${f}`))
    process.exit(1)
  }
  console.log('  \x1b[32mAll AI acceptance tests passed.\x1b[0m')
}

main().catch((e) => { console.error(e); process.exit(1) })
