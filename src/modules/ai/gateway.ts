/**
 * Centralized AI Gateway.
 *
 * Every ATS feature reaches a model through `invoke()`. Nothing else in the app
 * is allowed to call a provider directly. That gives one place to enforce:
 *
 *   - provider/model routing per feature (Part 11.F)
 *   - credential decryption, in memory only (Part 11.H)
 *   - retry with backoff on retryable failures (Part 11.D)
 *   - ordered fallback providers (Part 11.D)
 *   - usage/cost accounting on real token counts (Part 11.G)
 *   - budget + token limit enforcement with alerts (Part 11.G)
 *   - PII policy gating before an external call (Part 11.H)
 *   - redacted error logging (Part 11.H)
 */
import type { ChatMessage, ChatRequest, ChatResult, FeatureKey } from './types'
import { FEATURE_LABELS, ProviderError } from './types'
import { adapterFor } from './providers'
import { decryptSecret, masterKey, redact } from './crypto'
import { nowIso } from '../../lib/util'

export interface AiBindings {
  DB: D1Database
  AI_ENCRYPTION_KEY?: string
  AI_ENVIRONMENT?: string
}

export interface InvokeOptions {
  feature: FeatureKey
  messages: ChatMessage[]
  userId?: number | null
  /** Override configured routing (admin "test" path only). */
  providerId?: number
  modelId?: string
  temperature?: number
  maxTokens?: number
  /** Skip persistence for dry-run connection tests. */
  dryRun?: boolean
}

export interface InvokeResult extends ChatResult {
  providerSlug: string
  feature: FeatureKey
  attempts: number
  fellBack: boolean
  costUsd: number
}

/* ------------------------------------------------------------------ settings */
export const getSettings = async (db: D1Database): Promise<Record<string, string>> => {
  const { results } = await db.prepare('SELECT key, value FROM ai_settings').all<any>()
  return Object.fromEntries((results || []).map((r: any) => [r.key, r.value]))
}

export const setSetting = async (db: D1Database, key: string, value: string): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO ai_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, nowIso())
    .run()
}

/**
 * Ensure a per-installation encryption salt exists.
 *
 * Needed so a fresh install can store credentials before anyone sets
 * AI_ENCRYPTION_KEY. Generated once, then persisted in ai_settings.
 */
export const ensureSalt = async (db: D1Database): Promise<string> => {
  const row = await db
    .prepare("SELECT value FROM ai_settings WHERE key = 'encryption_salt'")
    .first<{ value: string }>()
  if (row?.value) return row.value
  const salt = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '')
  await setSetting(db, 'encryption_salt', salt)
  return salt
}

/* ----------------------------------------------------------- provider loading */
export interface ProviderRow {
  id: number
  slug: string
  name: string
  base_url: string
  api_key_enc: string | null
  api_key_iv: string | null
  api_key_hint: string | null
  org_id: string | null
  enabled: number
  local_only: number
  default_model: string | null
  status: string
  last_check_at: string | null
  last_error: string | null
}

export const loadProvider = async (db: D1Database, id: number): Promise<ProviderRow | null> =>
  (await db.prepare('SELECT * FROM ai_providers WHERE id = ?').bind(id).first<ProviderRow>()) || null

export const loadProviderBySlug = async (db: D1Database, slug: string): Promise<ProviderRow | null> =>
  (await db.prepare('SELECT * FROM ai_providers WHERE slug = ?').bind(slug).first<ProviderRow>()) || null

/** Decrypt a provider credential. Returns null for local providers that need none. */
export const credentialFor = async (
  env: AiBindings, provider: ProviderRow, settings: Record<string, string>
): Promise<string | null> => {
  if (provider.slug === 'ollama') return null
  if (!provider.api_key_enc || !provider.api_key_iv) return null
  const salt = settings.encryption_salt || (await ensureSalt(env.DB))
  const key = await masterKey(env.AI_ENCRYPTION_KEY, salt)
  return decryptSecret(key, provider.api_key_enc, provider.api_key_iv)
}

/* -------------------------------------------------------------------- usage */
const priceFor = async (db: D1Database, providerId: number, modelId: string) =>
  await db
    .prepare('SELECT input_price, output_price FROM ai_models WHERE provider_id = ? AND model_id = ?')
    .bind(providerId, modelId)
    .first<{ input_price: number | null; output_price: number | null }>()

export const computeCost = (
  inputTokens: number, outputTokens: number,
  inp: number | null | undefined, out: number | null | undefined
): number => {
  // Prices are stored per 1M tokens. Unknown pricing yields 0, never a guess.
  const i = ((inputTokens || 0) / 1_000_000) * (inp || 0)
  const o = ((outputTokens || 0) / 1_000_000) * (out || 0)
  return Math.round((i + o) * 1_000_000) / 1_000_000
}

const recordRequest = async (
  db: D1Database, row: {
    providerSlug: string; modelId: string; feature: string; userId?: number | null
    inputTokens: number; outputTokens: number; costUsd: number
    latencyMs: number; attempt: number; status: 'success' | 'error' | 'fallback' | 'blocked'
    errorCode?: string | null
  }
): Promise<void> => {
  await db.prepare(
    `INSERT INTO ai_requests
       (provider_slug, model_id, feature, user_id, input_tokens, output_tokens, total_tokens,
        cost_usd, latency_ms, attempt, status, error_code, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    row.providerSlug, row.modelId, row.feature, row.userId ?? null,
    row.inputTokens, row.outputTokens, row.inputTokens + row.outputTokens,
    row.costUsd, row.latencyMs, row.attempt, row.status, row.errorCode ?? null, nowIso()
  ).run()
}

/* ------------------------------------------------------------------- limits */
export interface LimitState { blocked: boolean; reason?: string; warnings: string[] }

export const checkLimits = async (
  db: D1Database, feature: string, providerSlug: string
): Promise<LimitState> => {
  const out: LimitState = { blocked: false, warnings: [] }
  const { results: limits } = await db
    .prepare('SELECT * FROM ai_usage_limits WHERE enabled = 1')
    .all<any>()
  if (!limits || !limits.length) return out

  for (const lim of limits) {
    if (lim.scope === 'provider' && lim.scope_ref && lim.scope_ref !== providerSlug) continue
    if (lim.scope === 'feature' && lim.scope_ref && lim.scope_ref !== feature) continue
    if (lim.scope === 'user') continue // per-user limits need a user id; handled by caller scope

    const since =
      lim.period === 'day' ? "datetime('now','-1 day')"
      : lim.period === 'week' ? "datetime('now','-7 day')"
      : "datetime('now','-30 day')"
    const agg = await db.prepare(
      `SELECT COALESCE(SUM(total_tokens),0) AS tok, COALESCE(SUM(cost_usd),0) AS cost
         FROM ai_requests WHERE created_at >= ${since} AND status IN ('success','fallback')`
    ).first<any>()

    const usedTok = Number(agg?.tok || 0)
    const usedCost = Number(agg?.cost || 0)

    if (lim.limit_tokens) {
      const pct = (usedTok / lim.limit_tokens) * 100
      if (pct >= 100) {
        return { blocked: true, reason: `${lim.scope} token limit reached for this ${lim.period}`, warnings: out.warnings }
      }
      if (pct >= (lim.alert_at_pct || 80)) out.warnings.push(`${lim.scope} at ${Math.round(pct)}% of ${lim.period} token limit`)
    }
    if (lim.limit_cost) {
      const pct = (usedCost / lim.limit_cost) * 100
      if (pct >= 100) {
        return { blocked: true, reason: `${lim.scope} cost limit reached for this ${lim.period}`, warnings: out.warnings }
      }
      if (pct >= (lim.alert_at_pct || 80)) out.warnings.push(`${lim.scope} at ${Math.round(pct)}% of ${lim.period} cost limit`)
    }
  }
  return out
}

/* --------------------------------------------------------------- PII policy */
/**
 * Privacy gate (Part 11.H). `redact` (default) strips emails/phones from
 * outbound text when the target provider is external; `block` refuses external
 * calls entirely; `allow` passes through. Local providers are unaffected.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/g

export const applyPiiPolicy = (
  messages: ChatMessage[], policy: string, isExternal: boolean
): ChatMessage[] => {
  if (!isExternal || policy === 'allow') return messages
  if (policy === 'block') {
    const has = messages.some((m) => EMAIL_RE.test(m.content) || PHONE_RE.test(m.content))
    EMAIL_RE.lastIndex = 0
    PHONE_RE.lastIndex = 0
    if (has) {
      throw new ProviderError(
        'pii_blocked',
        'Privacy policy blocks sending contact details to an external provider. Use a local Ollama provider or set the PII policy to "redact".'
      )
    }
    return messages
  }
  return messages.map((m) => ({
    ...m,
    content: m.content.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]')
  }))
}

/* ---------------------------------------------------------------- resolution */
interface Route { provider: ProviderRow; modelId: string; isFallback: boolean }

const resolveRoute = async (
  db: D1Database, opts: InvokeOptions
): Promise<Route[]> => {
  const routes: Route[] = []

  if (opts.providerId) {
    const p = await loadProvider(db, opts.providerId)
    if (!p) throw new ProviderError('provider_not_found', `Provider ${opts.providerId} does not exist`)
    routes.push({ provider: p, modelId: opts.modelId || p.default_model || '', isFallback: false })
    return routes
  }

  const cfg = await db
    .prepare('SELECT * FROM ai_feature_config WHERE feature = ?')
    .bind(opts.feature)
    .first<any>()

  if (cfg && cfg.enabled === 0) {
    throw new ProviderError('feature_disabled', `AI feature "${FEATURE_LABELS[opts.feature].label}" is switched off by an administrator`)
  }

  if (cfg?.provider_id) {
    const p = await loadProvider(db, cfg.provider_id)
    if (p?.enabled) {
      routes.push({ provider: p, modelId: opts.modelId || cfg.model_id || p.default_model || '', isFallback: false })
    }
  }
  if (cfg?.fallback_provider_id) {
    const f = await loadProvider(db, cfg.fallback_provider_id)
    if (f?.enabled && f.id !== routes[0]?.provider.id) {
      routes.push({ provider: f, modelId: cfg.fallback_model_id || f.default_model || '', isFallback: true })
    }
  }

  // No explicit routing: use the first enabled provider with a usable model.
  if (!routes.length) {
    const { results } = await db
      .prepare('SELECT * FROM ai_providers WHERE enabled = 1 ORDER BY sort_order, id')
      .all<ProviderRow>()
    for (const p of results || []) {
      const model = opts.modelId || p.default_model
      if (model) { routes.push({ provider: p, modelId: model, isFallback: false }); break }
    }
  }

  if (!routes.length) {
    throw new ProviderError(
      'no_provider',
      'No AI provider is enabled. An administrator must add an API key and enable a provider under Settings → AI Integration.'
    )
  }
  return routes
}

/* -------------------------------------------------------------------- invoke */
export const invoke = async (
  env: AiBindings, opts: InvokeOptions
): Promise<InvokeResult> => {
  const db = env.DB
  const settings = await getSettings(db)
  const routes = await resolveRoute(db, opts)
  const allowExternal = settings.external_calls_enabled !== '0'
  const maxRetries = Math.max(0, Number(settings.max_retries ?? 2))

  const cfg = await db
    .prepare('SELECT temperature, max_tokens FROM ai_feature_config WHERE feature = ?')
    .bind(opts.feature)
    .first<any>()

  let attempts = 0
  const errors: string[] = []

  for (const route of routes) {
    const { provider, modelId } = route
    const isExternal = provider.local_only !== 1

    if (isExternal && !allowExternal) {
      errors.push(`${provider.slug}: external AI calls are disabled by policy`)
      continue
    }
    if (!modelId) {
      errors.push(`${provider.slug}: no model selected`)
      continue
    }

    const limit = await checkLimits(db, opts.feature, provider.slug)
    if (limit.blocked) {
      errors.push(`${provider.slug}: ${limit.reason}`)
      if (!opts.dryRun) {
        await recordRequest(db, {
          providerSlug: provider.slug, modelId, feature: opts.feature, userId: opts.userId,
          inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0,
          attempt: attempts + 1, status: 'blocked', errorCode: 'usage_limit'
        })
      }
      continue
    }

    let apiKey: string | null = null
    try {
      apiKey = await credentialFor(env, provider, settings)
    } catch (e: any) {
      errors.push(`${provider.slug}: credential unavailable (${redact(e?.message || '')})`)
      continue
    }
    if (isExternal && !apiKey) {
      errors.push(`${provider.slug}: no API key configured`)
      continue
    }

    let messages: ChatMessage[]
    try {
      messages = applyPiiPolicy(opts.messages, settings.pii_policy || 'redact', isExternal)
    } catch (e: any) {
      errors.push(redact(e?.message || ''))
      continue
    }

    const req: ChatRequest = {
      model: modelId,
      messages,
      temperature: opts.temperature ?? cfg?.temperature ?? 0.3,
      maxTokens: opts.maxTokens ?? cfg?.max_tokens ?? 1200
    }

    const adapter = adapterFor(provider.slug)

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      attempts++
      const started = Date.now()
      try {
        const ctx = { apiKey, baseUrl: provider.base_url, orgId: provider.org_id }
        const result = await adapter.chat(ctx, req)
        const latency = Date.now() - started

        const price = await priceFor(db, provider.id, modelId)
        const costUsd = computeCost(
          result.usage.inputTokens, result.usage.outputTokens,
          price?.input_price, price?.output_price
        )

        if (!opts.dryRun) {
          await recordRequest(db, {
            providerSlug: provider.slug, modelId, feature: opts.feature, userId: opts.userId,
            inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
            costUsd, latencyMs: latency, attempt,
            status: route.isFallback ? 'fallback' : 'success'
          })
          await db.prepare(
            `UPDATE ai_providers SET status='connected', last_check_at=?, last_error=NULL WHERE id=?`
          ).bind(nowIso(), provider.id).run()
        }

        return {
          ...result,
          providerSlug: provider.slug,
          feature: opts.feature,
          attempts,
          fellBack: route.isFallback,
          costUsd
        }
      } catch (err: any) {
        const latency = Date.now() - started
        const retryable = err instanceof ProviderError ? err.retryable : false
        const code = err instanceof ProviderError ? err.code : 'unknown_error'
        errors.push(`${provider.slug}: ${redact(err?.message || 'request failed')}`)

        if (!opts.dryRun) {
          await recordRequest(db, {
            providerSlug: provider.slug, modelId, feature: opts.feature, userId: opts.userId,
            inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: latency,
            attempt, status: 'error', errorCode: code
          })
        }

        if (retryable && attempt <= maxRetries) {
          // Exponential backoff: 400ms, 800ms, 1600ms…
          await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)))
          continue
        }
        if (!opts.dryRun) {
          await db.prepare(
            `UPDATE ai_providers SET status='error', last_check_at=?, last_error=? WHERE id=?`
          ).bind(nowIso(), redact(err?.message || 'request failed').slice(0, 300), provider.id).run()
        }
        break // move to the next fallback provider
      }
    }
  }

  throw new ProviderError(
    'all_providers_failed',
    `AI request failed. ${errors.slice(-3).join(' | ')}`
  )
}

/* -------------------------------------------------------- connection testing */
export const testProvider = async (
  env: AiBindings, providerId: number
): Promise<{ ok: boolean; message: string; models?: number }> => {
  const db = env.DB
  const settings = await getSettings(db)
  const provider = await loadProvider(db, providerId)
  if (!provider) return { ok: false, message: 'Provider not found' }

  let apiKey: string | null = null
  try {
    apiKey = await credentialFor(env, provider, settings)
  } catch (e: any) {
    return { ok: false, message: `Cannot decrypt stored credential: ${redact(e?.message || '')}` }
  }
  if (provider.local_only !== 1 && !apiKey) {
    return { ok: false, message: 'No API key saved for this provider.' }
  }

  const adapter = adapterFor(provider.slug)
  const res = await adapter.testConnection({ apiKey, baseUrl: provider.base_url, orgId: provider.org_id })

  await db.prepare(
    `UPDATE ai_providers SET status=?, last_check_at=?, last_error=? WHERE id=?`
  ).bind(
    res.ok ? 'connected' : 'error', nowIso(),
    res.ok ? null : redact(res.message).slice(0, 300), providerId
  ).run()

  return res
}

/* ------------------------------------------------------------ model discovery */
export const discoverModels = async (
  env: AiBindings, providerId: number
): Promise<{ ok: boolean; message: string; added: number; total: number }> => {
  const db = env.DB
  const settings = await getSettings(db)
  const provider = await loadProvider(db, providerId)
  if (!provider) return { ok: false, message: 'Provider not found', added: 0, total: 0 }

  let apiKey: string | null = null
  try {
    apiKey = await credentialFor(env, provider, settings)
  } catch (e: any) {
    return { ok: false, message: `Cannot decrypt credential: ${redact(e?.message || '')}`, added: 0, total: 0 }
  }

  const adapter = adapterFor(provider.slug)
  let models
  try {
    models = await adapter.listModels({ apiKey, baseUrl: provider.base_url, orgId: provider.org_id })
  } catch (e: any) {
    return { ok: false, message: redact(e?.message || 'Discovery failed'), added: 0, total: 0 }
  }

  let added = 0
  for (const m of models) {
    // Upsert: refresh metadata but never clobber an admin-set custom price.
    const existing = await db
      .prepare('SELECT id FROM ai_models WHERE provider_id = ? AND model_id = ?')
      .bind(providerId, m.modelId)
      .first<any>()
    if (existing) {
      await db.prepare(
        `UPDATE ai_models SET name=?, context_window=COALESCE(?, context_window),
           availability='available', discovered_at=? WHERE id=?`
      ).bind(m.name, m.contextWindow ?? null, nowIso(), existing.id).run()
    } else {
      await db.prepare(
        `INSERT INTO ai_models
           (provider_id, model_id, name, context_window, input_price, output_price,
            vision, tools, streaming, availability, source, discovered_at)
         VALUES (?,?,?,?,?,?,?,?,?,'available','discovered',?)`
      ).bind(
        providerId, m.modelId, m.name, m.contextWindow ?? null,
        m.inputPrice ?? null, m.outputPrice ?? null,
        m.vision ? 1 : 0, m.tools ? 1 : 0, m.streaming === false ? 0 : 1, nowIso()
      ).run()
      added++
    }
  }

  await db.prepare('UPDATE ai_providers SET status=?, last_check_at=?, last_error=NULL WHERE id=?')
    .bind('connected', nowIso(), providerId).run()

  return {
    ok: true,
    message: `Discovery complete: ${models.length} model(s) visible, ${added} newly added.`,
    added,
    total: models.length
  }
}

/* --------------------------------------------------------------------- audit */
export const aiAudit = async (
  db: D1Database, actorId: number | null, action: string, target: string, detail: unknown = {}
): Promise<void> => {
  await db.prepare(
    'INSERT INTO ai_audit (actor_id, action, target, detail, created_at) VALUES (?,?,?,?,?)'
  ).bind(actorId, action, target, redact(JSON.stringify(detail)), nowIso()).run()
}

/* --------------------------------------------------------------- usage report */
export interface UsageReport {
  totals: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; failures: number; avgLatency: number }
  byProvider: any[]
  byModel: any[]
  byFeature: any[]
  daily: any[]
  limits: any[]
}

export const loadUsage = async (db: D1Database, days = 30): Promise<UsageReport> => {
  const since = `datetime('now','-${days} day')`

  const totals = await db.prepare(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(input_tokens),0) AS inputTokens,
            COALESCE(SUM(output_tokens),0) AS outputTokens,
            COALESCE(SUM(total_tokens),0) AS totalTokens,
            COALESCE(SUM(cost_usd),0) AS costUsd,
            COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS failures,
            COALESCE(AVG(CASE WHEN status IN ('success','fallback') THEN latency_ms END),0) AS avgLatency
       FROM ai_requests WHERE created_at >= ${since}`
  ).first<any>()

  const byProvider = await db.prepare(
    `SELECT provider_slug AS provider, COUNT(*) AS requests,
            COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost,
            COALESCE(AVG(latency_ms),0) AS latency
       FROM ai_requests WHERE created_at >= ${since}
      GROUP BY provider_slug ORDER BY tokens DESC`
  ).all<any>()

  const byModel = await db.prepare(
    `SELECT COALESCE(model_id,'—') AS model, provider_slug AS provider, COUNT(*) AS requests,
            COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost
       FROM ai_requests WHERE created_at >= ${since}
      GROUP BY provider_slug, model_id ORDER BY tokens DESC LIMIT 25`
  ).all<any>()

  const byFeature = await db.prepare(
    `SELECT feature, COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens,
            COALESCE(SUM(cost_usd),0) AS cost, COALESCE(AVG(latency_ms),0) AS latency
       FROM ai_requests WHERE created_at >= ${since}
      GROUP BY feature ORDER BY tokens DESC`
  ).all<any>()

  const daily = await db.prepare(
    `SELECT substr(created_at,1,10) AS day, COUNT(*) AS requests,
            COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost
       FROM ai_requests WHERE created_at >= ${since}
      GROUP BY day ORDER BY day`
  ).all<any>()

  const limits = await db.prepare('SELECT * FROM ai_usage_limits ORDER BY id').all<any>()

  return {
    totals: {
      requests: Number(totals?.requests || 0),
      inputTokens: Number(totals?.inputTokens || 0),
      outputTokens: Number(totals?.outputTokens || 0),
      totalTokens: Number(totals?.totalTokens || 0),
      costUsd: Number(totals?.costUsd || 0),
      failures: Number(totals?.failures || 0),
      avgLatency: Math.round(Number(totals?.avgLatency || 0))
    },
    byProvider: byProvider.results || [],
    byModel: byModel.results || [],
    byFeature: byFeature.results || [],
    daily: daily.results || [],
    limits: limits.results || []
  }
}
