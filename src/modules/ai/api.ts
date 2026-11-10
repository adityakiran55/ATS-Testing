/**
 * AI administration + feature API.
 *
 * Mounted at /api/ai. Every route is permission-gated:
 *   ai.read       — view providers/models/feature config (recruiter+)
 *   ai.configure  — admin only: keys, providers, models, routing, security
 *   ai.invoke     — call an AI feature
 *   ai.usage      — usage/cost dashboards (admin)
 *
 * API keys are write-only over the wire: they are encrypted on the way in and
 * only ever leave as `api_key_hint` (last four characters).
 */
import { Hono } from 'hono'
import type { AppEnv } from '../../lib/auth'
import { currentUser, requireAuth } from '../../lib/auth'
import { can } from '../../lib/rbac'
import { audit } from '../../lib/audit'
import { nowIso, truncate } from '../../lib/util'
import { encryptSecret, keyHint, masterKey, redact, decryptSecret } from '../ai/crypto'
import {
  getSettings, setSetting, aiAudit, testProvider, discoverModels, loadUsage,
  checkLimits, invoke, loadProvider, ensureSalt
} from '../ai/gateway'
import { FEATURE_LABELS } from '../ai/types'
import type { FeatureKey } from '../ai/types'
import { runFeature, listFeatures } from '../ai/features'

export const aiApi = new Hono<AppEnv>()

const deny = (c: any, what = 'forbidden') =>
  c.json({ error: what, message: 'You do not have permission for this AI action.' }, 403)

/* ------------------------------------------------------------------ overview */
aiApi.get('/overview', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.read')) return deny(c)
  const db = c.env.DB

  const providers = await db.prepare(
    `SELECT p.id, p.slug, p.name, p.logo, p.base_url, p.enabled, p.local_only,
            p.default_model, p.status, p.last_check_at, p.last_error,
            p.api_key_hint, p.org_id,
            (SELECT COUNT(*) FROM ai_models m WHERE m.provider_id = p.id) AS model_count
       FROM ai_providers p ORDER BY p.sort_order, p.id`
  ).all<any>()

  const features = await db.prepare(
    `SELECT f.*, p.name AS provider_name, p.slug AS provider_slug, fp.name AS fallback_name
       FROM ai_feature_config f
       LEFT JOIN ai_providers p ON p.id = f.provider_id
       LEFT JOIN ai_providers fp ON fp.id = f.fallback_provider_id
      ORDER BY f.feature`
  ).all<any>()

  const usage = await loadUsage(db, 30)
  const settings = await getSettings(db)

  const activeProviders = (providers.results || []).filter((p: any) => p.enabled).length
  const configured = (providers.results || []).filter((p: any) => p.api_key_hint || p.local_only).length

  return c.json({
    providers: providers.results || [],
    features: features.results || [],
    usage,
    settings: {
      pii_policy: settings.pii_policy,
      external_calls_enabled: settings.external_calls_enabled,
      max_retries: settings.max_retries,
      request_timeout_ms: settings.request_timeout_ms,
      request_log_retention_days: settings.request_log_retention_days
    },
    summary: {
      providers_total: (providers.results || []).length,
      providers_enabled: activeProviders,
      providers_configured: configured,
      features_total: (features.results || []).length,
      features_routed: (features.results || []).filter((f: any) => f.provider_id).length
    }
  })
})

/* -------------------------------------------------------------- feature list */
aiApi.get('/features', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.read')) return deny(c)
  return c.json({ features: await listFeatures(c.env.DB) })
})

/* ------------------------------------------------------------------ providers */
aiApi.get('/providers', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.read')) return deny(c)
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM ai_models m WHERE m.provider_id = p.id) AS model_count
       FROM ai_providers p ORDER BY p.sort_order, p.id`
  ).all<any>()
  // Never leak ciphertext or IV fields to the client.
  const safe = (results || []).map((p: any) => {
    const { api_key_enc, api_key_iv, ...rest } = p
    return { ...rest, has_key: Boolean(api_key_enc) }
  })
  return c.json({ providers: safe })
})

/**
 * Create or update a provider. The same shape handles both: pass `id` to update.
 * A blank/absent `api_key` leaves the stored credential untouched.
 */
aiApi.post('/providers', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.configure')) return deny(c)
  const db = c.env.DB
  const body: any = await c.req.json().catch(() => ({}))
  const settings = await getSettings(db)

  const slug = String(body.slug || '').trim()
  if (!slug) return c.json({ error: 'invalid_input', message: 'Provider slug is required' }, 400)

  const existing = body.id
    ? await db.prepare('SELECT * FROM ai_providers WHERE id = ?').bind(Number(body.id)).first<any>()
    : await db.prepare('SELECT * FROM ai_providers WHERE slug = ?').bind(slug).first<any>()

  if (!existing && !body.name) {
    return c.json({ error: 'invalid_input', message: 'Provider name is required' }, 400)
  }

  // Credential handling — encrypted at rest, hint retained for display only.
  let enc: string | null = existing?.api_key_enc ?? null
  let iv: string | null = existing?.api_key_iv ?? null
  let hint: string | null = existing?.api_key_hint ?? null
  let keyRotated = false

  if (typeof body.api_key === 'string' && body.api_key.trim() !== '') {
    const raw = body.api_key.trim()
    try {
      // Bootstrap the per-installation salt on first use so a fresh install can
      // store credentials without anyone setting AI_ENCRYPTION_KEY manually.
      const salt = settings.encryption_salt || (await ensureSalt(db))
      const mk = await masterKey(c.env.AI_ENCRYPTION_KEY, salt)
      const out = await encryptSecret(mk, raw)
      enc = out.ciphertext
      iv = out.iv
      hint = keyHint(raw)
      keyRotated = true
    } catch (e: any) {
      return c.json({
        error: 'encryption_unconfigured',
        message: `Cannot encrypt credentials: ${redact(e?.message || 'unknown error')}`
      }, 500)
    }
  }
  if (body.clear_key === true) { enc = null; iv = null; hint = null; keyRotated = true }

  const enabled = body.enabled === undefined ? (existing?.enabled ?? 0) : (body.enabled ? 1 : 0)
  const baseUrl = String(body.base_url || existing?.base_url || '').trim()

  if (enabled && !hint && slug !== 'ollama') {
    return c.json({
      error: 'missing_key',
      message: 'Add an API key before enabling this provider.'
    }, 400)
  }

  let id: number
  if (existing) {
    await db.prepare(
      `UPDATE ai_providers SET name=?, logo=?, base_url=?, api_key_enc=?, api_key_iv=?, api_key_hint=?,
         org_id=?, enabled=?, default_model=?, status=?, updated_at=? WHERE id=?`
    ).bind(
      String(body.name ?? existing.name), String(body.logo ?? existing.logo ?? ''),
      baseUrl, enc, iv, hint, String(body.org_id ?? existing.org_id ?? ''),
      enabled, String(body.default_model ?? existing.default_model ?? ''),
      enabled ? existing.status : 'disabled', nowIso(), existing.id
    ).run()
    id = existing.id
  } else {
    const res = await db.prepare(
      `INSERT INTO ai_providers
         (slug, name, logo, base_url, api_key_enc, api_key_iv, api_key_hint, org_id,
          enabled, default_model, status, sort_order, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      slug, String(body.name), String(body.logo ?? ''), baseUrl, enc, iv, hint,
      String(body.org_id ?? ''), enabled, String(body.default_model ?? ''),
      enabled ? 'not_configured' : 'disabled', Number(body.sort_order ?? 500), nowIso(), nowIso()
    ).run()
    id = Number(res.meta.last_row_id)
  }

  await aiAudit(db, u.id, keyRotated ? 'provider.key_rotated' : 'provider.saved', `provider:${id}`, {
    slug, enabled, key_rotated: keyRotated, has_key: Boolean(enc)
  })
  await audit(db, {
    entityType: 'ai_provider', entityId: id, action: existing ? 'update' : 'create',
    actorId: u.id, meta: { slug, enabled, key_rotated: keyRotated }
  })

  const saved = await db.prepare('SELECT * FROM ai_providers WHERE id = ?').bind(id).first<any>()
  const { api_key_enc, api_key_iv, ...safe } = saved
  return c.json({ ok: true, message: keyRotated ? 'Provider saved and API key encrypted.' : 'Provider saved.', provider: safe })
})

/** Enable / disable without resending the credential. */
aiApi.patch('/providers/:id', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.configure')) return deny(c)
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const body: any = await c.req.json().catch(() => ({}))
  const p = await db.prepare('SELECT * FROM ai_providers WHERE id = ?').bind(id).first<any>()
  if (!p) return c.json({ error: 'not_found', message: 'Provider not found' }, 404)

  if (body.enabled !== undefined) {
    if (body.enabled && !p.api_key_hint && p.slug !== 'ollama') {
      return c.json({ error: 'missing_key', message: 'Add an API key before enabling this provider.' }, 400)
    }
    await db.prepare('UPDATE ai_providers SET enabled=?, status=?, updated_at=? WHERE id=?')
      .bind(body.enabled ? 1 : 0, body.enabled ? (p.status === 'disabled' ? 'not_configured' : p.status) : 'disabled', nowIso(), id)
      .run()
  }
  if (body.default_model !== undefined) {
    await db.prepare('UPDATE ai_providers SET default_model=?, updated_at=? WHERE id=?')
      .bind(String(body.default_model), nowIso(), id).run()
  }
  await aiAudit(db, u.id, 'provider.updated', `provider:${id}`, body)
  return c.json({ ok: true, message: 'Provider updated.' })
})

/** Real credential validation against the provider's live API. */
aiApi.post('/providers/:id/test', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.configure')) return deny(c)
  const id = Number(c.req.param('id'))
  const res = await testProvider(c.env as any, id)
  await aiAudit(c.env.DB, u.id, 'provider.tested', `provider:${id}`, { ok: res.ok, message: redact(res.message) })
  return c.json(res, res.ok ? 200 : 400)
})

/** Dynamic model discovery. */
aiApi.post('/providers/:id/discover', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.configure')) return deny(c)
  const id = Number(c.req.param('id'))
  const res = await discoverModels(c.env as any, id)
  await aiAudit(c.env.DB, u.id, 'provider.models_discovered', `provider:${id}`, res)
  return c.json(res, res.ok ? 200 : 400)
})

/* --------------------------------------------------------------------- models */
aiApi.get('/models', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.read')) return deny(c)
  const providerId = c.req.query('providerId')
  const sql = `SELECT m.*, p.name AS provider_name, p.slug AS provider_slug
                 FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id
                ${providerId ? 'WHERE m.provider_id = ?' : ''}
                ORDER BY p.sort_order, m.name`
  const stmt = providerId ? c.env.DB.prepare(sql).bind(Number(providerId)) : c.env.DB.prepare(sql)
  const { results } = await stmt.all<any>()
  return c.json({ models: results || [] })
})

/** Register a model by ID — for providers whose model list is admin-maintained. */
aiApi.post('/models', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.configure')) return deny(c)
  const b: any = await c.req.json().catch(() => ({}))
  const providerId = Number(b.provider_id)
  const modelId = String(b.model_id || '').trim()
  if (!providerId || !modelId) {
    return c.json({ error: 'invalid_input', message: 'provider_id and model_id are required' }, 400)
  }
  const exists = await c.env.DB.prepare('SELECT id FROM ai_models WHERE provider_id=? AND model_id=?')
    .bind(providerId, modelId).first<any>()
  if (exists) return c.json({ error: 'exists', message: 'That model is already registered.' }, 409)

  const res = await c.env.DB.prepare(
    `INSERT INTO ai_models (provider_id, model_id, name, context_window, input_price, output_price,
       vision, tools, streaming, availability, source, discovered_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    providerId, modelId, String(b.name || modelId),
    b.context_window ? Number(b.context_window) : null,
    b.input_price !== undefined && b.input_price !== '' ? Number(b.input_price) : null,
    b.output_price !== undefined && b.output_price !== '' ? Number(b.output_price) : null,
    b.vision ? 1 : 0, b.tools ? 1 : 0, b.streaming === false ? 0 : 1,
    'available', 'custom', nowIso()
  ).run()

  await aiAudit(c.env.DB, u.id, 'model.registered', `model:${res.meta.last_row_id}`, { providerId, modelId })
  return c.json({ ok: true, message: `Model ${modelId} registered.`, id: res.meta.last_row_id })
})

/** Edit pricing/capabilities or delete a manually-added model. */
aiApi.patch('/models/:id', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.configure')) return deny(c)
  const id = Number(c.req.param('id'))
  const b: any = await c.req.json().catch(() => ({}))
  const m = await c.env.DB.prepare('SELECT * FROM ai_models WHERE id=?').bind(id).first<any>()
  if (!m) return c.json({ error: 'not_found', message: 'Model not found' }, 404)

  await c.env.DB.prepare(
    `UPDATE ai_models SET name=?, context_window=?, input_price=?, output_price=?,
       vision=?, tools=?, streaming=?, availability=? WHERE id=?`
  ).bind(
    String(b.name ?? m.name),
    b.context_window !== undefined ? (b.context_window === '' ? null : Number(b.context_window)) : m.context_window,
    b.input_price !== undefined ? (b.input_price === '' ? null : Number(b.input_price)) : m.input_price,
    b.output_price !== undefined ? (b.output_price === '' ? null : Number(b.output_price)) : m.output_price,
    b.vision !== undefined ? (b.vision ? 1 : 0) : m.vision,
    b.tools !== undefined ? (b.tools ? 1 : 0) : m.tools,
    b.streaming !== undefined ? (b.streaming ? 1 : 0) : m.streaming,
    String(b.availability ?? m.availability), id
  ).run()
  await aiAudit(c.env.DB, u.id, 'model.updated', `model:${id}`, b)
  return c.json({ ok: true, message: 'Model updated.' })
})

aiApi.delete('/models/:id', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.configure')) return deny(c)
  const id = Number(c.req.param('id'))
  const m = await c.env.DB.prepare('SELECT * FROM ai_models WHERE id=?').bind(id).first<any>()
  if (!m) return c.json({ error: 'not_found', message: 'Model not found' }, 404)
  if (m.source === 'discovered') {
    return c.json({
      error: 'not_deletable',
      message: 'Discovered models are refreshed by the provider. Mark it unavailable instead.'
    }, 400)
  }
  await c.env.DB.prepare('DELETE FROM ai_models WHERE id=?').bind(id).run()
  await aiAudit(c.env.DB, u.id, 'model.deleted', `model:${id}`, { modelId: m.model_id })
  return c.json({ ok: true, message: 'Model removed.' })
})

/* ------------------------------------------------------- feature → model routing */
aiApi.post('/features/:feature', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.configure')) return deny(c)
  const feature = c.req.param('feature') as FeatureKey
  if (!FEATURE_LABELS[feature]) return c.json({ error: 'not_found', message: 'Unknown AI feature' }, 404)
  const b: any = await c.req.json().catch(() => ({}))

  const nullify = (v: any) => (v === '' || v === undefined || v === null || v === 0 || v === '0' ? null : Number(v))

  await c.env.DB.prepare(
    `INSERT INTO ai_feature_config
       (feature, provider_id, model_id, fallback_provider_id, fallback_model_id,
        temperature, max_tokens, enabled, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(feature) DO UPDATE SET
       provider_id=excluded.provider_id, model_id=excluded.model_id,
       fallback_provider_id=excluded.fallback_provider_id,
       fallback_model_id=excluded.fallback_model_id,
       temperature=excluded.temperature, max_tokens=excluded.max_tokens,
       enabled=excluded.enabled, updated_at=excluded.updated_at`
  ).bind(
    feature, nullify(b.provider_id), b.model_id || null,
    nullify(b.fallback_provider_id), b.fallback_model_id || null,
    b.temperature !== undefined ? Number(b.temperature) : 0.3,
    b.max_tokens !== undefined ? Number(b.max_tokens) : 1200,
    b.enabled === undefined ? 1 : (b.enabled ? 1 : 0),
    nowIso()
  ).run()

  await aiAudit(c.env.DB, u.id, 'feature.routed', `feature:${feature}`, b)
  return c.json({ ok: true, message: `${FEATURE_LABELS[feature].label} routing saved.` })
})

/* -------------------------------------------------------------------- settings */
aiApi.post('/settings', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.configure')) return deny(c)
  const b: any = await c.req.json().catch(() => ({}))
  const allowed = ['pii_policy', 'external_calls_enabled', 'max_retries', 'request_timeout_ms', 'request_log_retention_days']
  let changed = 0
  for (const k of allowed) {
    if (b[k] !== undefined) {
      if (k === 'pii_policy' && !['block', 'redact', 'allow'].includes(String(b[k]))) {
        return c.json({ error: 'invalid_input', message: 'pii_policy must be block, redact or allow' }, 400)
      }
      await setSetting(c.env.DB, k, String(b[k]))
      changed++
    }
  }
  await aiAudit(c.env.DB, u.id, 'settings.updated', 'ai_settings', b)
  return c.json({ ok: true, message: `${changed} setting(s) saved.` })
})

/* ---------------------------------------------------------------------- usage */
aiApi.get('/usage', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.usage')) return deny(c)
  const days = Number(c.req.query('days') || 30)
  return c.json(await loadUsage(c.env.DB, days))
})

aiApi.post('/limits', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.configure')) return deny(c)
  const b: any = await c.req.json().catch(() => ({}))
  await c.env.DB.prepare(
    `INSERT INTO ai_usage_limits
       (scope, scope_ref, period, limit_tokens, limit_cost, alert_at_pct, enabled, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(
    String(b.scope || 'global'), b.scope_ref || null, String(b.period || 'month'),
    b.limit_tokens ? Number(b.limit_tokens) : null,
    b.limit_cost ? Number(b.limit_cost) : null,
    Number(b.alert_at_pct ?? 80), 1, nowIso()
  ).run()
  await aiAudit(c.env.DB, u.id, 'limit.created', 'ai_usage_limits', b)
  return c.json({ ok: true, message: 'Usage limit created.' })
})

aiApi.delete('/limits/:id', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.configure')) return deny(c)
  await c.env.DB.prepare('DELETE FROM ai_usage_limits WHERE id=?').bind(Number(c.req.param('id'))).run()
  return c.json({ ok: true, message: 'Usage limit removed.' })
})

/** Current headroom against every active limit — for the dashboard banner. */
aiApi.get('/limits/status', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.usage')) return deny(c)
  const state = await checkLimits(c.env.DB, 'chat_assistant', '')
  return c.json(state)
})

/* ----------------------------------------------------------------- request log */
aiApi.get('/logs', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.usage')) return deny(c)
  const q = c.req.query()
  const limit = Math.min(200, Number(q.limit || 60))
  const where: string[] = []
  const binds: any[] = []
  if (q.provider) { where.push('provider_slug = ?'); binds.push(q.provider) }
  if (q.feature) { where.push('feature = ?'); binds.push(q.feature) }
  if (q.status) { where.push('status = ?'); binds.push(q.status) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, u.name AS user_name
       FROM ai_requests r LEFT JOIN users u ON u.id = r.user_id
       ${clause} ORDER BY r.id DESC LIMIT ?`
  ).bind(...binds, limit).all<any>()
  return c.json({ logs: results || [] })
})

aiApi.get('/audit', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.usage')) return deny(c)
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, u.name AS actor_name FROM ai_audit a
       LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 100`
  ).all<any>()
  return c.json({ audit: results || [] })
})

/** Purge request logs past the retention window. */
aiApi.post('/logs/purge', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.configure')) return deny(c)
  const settings = await getSettings(c.env.DB)
  const days = Number(settings.request_log_retention_days || 90)
  const res = await c.env.DB.prepare(
    `DELETE FROM ai_requests WHERE created_at < datetime('now','-${days} day')`
  ).run()
  await aiAudit(c.env.DB, u.id, 'logs.purged', 'ai_requests', { days, deleted: res.meta.changes })
  return c.json({ ok: true, message: `Removed ${res.meta.changes} log rows older than ${days} days.` })
})

/* ------------------------------------------------------- feature execution API */
/**
 * Run an ATS AI feature. This is the only path app code uses to reach a model:
 * routing, privacy, limits and accounting all live in the gateway.
 */
aiApi.post('/run/:feature', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.invoke')) return deny(c)
  const feature = c.req.param('feature') as FeatureKey
  if (!FEATURE_LABELS[feature]) return c.json({ error: 'not_found', message: 'Unknown AI feature' }, 404)

  const body: any = await c.req.json().catch(() => ({}))
  try {
    const out = await runFeature(c.env as any, feature, body, u)
    return c.json(out)
  } catch (e: any) {
    const code = e?.code || 'ai_error'
    const status = code === 'pii_blocked' ? 400
      : code === 'no_provider' || code === 'feature_disabled' ? 409
      : code === 'all_providers_failed' ? 502 : 500
    return c.json({ error: code, message: redact(e?.message || 'AI request failed') }, status as any)
  }
})

/** Ad-hoc chat for the assistant panel — same gateway, no feature routing override. */
aiApi.post('/chat', requireAuth, async (c) => {
  const u = currentUser(c)
  if (!can(u.role, 'ai.invoke')) return deny(c)
  const body: any = await c.req.json().catch(() => ({}))
  const question = String(body.message || '').trim()
  if (!question) return c.json({ error: 'invalid_input', message: 'Message is required' }, 400)
  if (question.length > 4000) return c.json({ error: 'too_long', message: 'Message exceeds 4000 characters' }, 400)

  try {
    const out = await runFeature(c.env as any, 'chat_assistant', { message: question }, u)
    return c.json(out)
  } catch (e: any) {
    return c.json({ error: e?.code || 'ai_error', message: redact(e?.message || 'AI request failed') }, 502)
  }
})
