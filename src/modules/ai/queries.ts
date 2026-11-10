/**
 * Read models for the AI administration screens.
 *
 * Deliberately separate from the API layer: page routes are server-rendered and
 * pass plain props, matching the rest of the app. Credential ciphertext is
 * stripped here so a page can never accidentally render it.
 */
import type { D1Database } from '@cloudflare/workers-types'

export interface SafeProvider {
  id: number
  slug: string
  name: string
  logo: string
  base_url: string
  org_id: string | null
  enabled: number
  local_only: number
  default_model: string | null
  status: string
  last_check_at: string | null
  last_error: string | null
  api_key_hint: string | null
  has_key: boolean
  model_count: number
}

export const loadProviders = async (db: D1Database): Promise<SafeProvider[]> => {
  const { results } = await db.prepare(
    `SELECT p.id, p.slug, p.name, p.logo, p.base_url, p.org_id, p.enabled, p.local_only,
            p.default_model, p.status, p.last_check_at, p.last_error, p.api_key_hint,
            (p.api_key_enc IS NOT NULL) AS has_key,
            (SELECT COUNT(*) FROM ai_models m WHERE m.provider_id = p.id) AS model_count
       FROM ai_providers p ORDER BY p.sort_order, p.id`
  ).all<any>()
  return (results || []).map((r: any) => ({ ...r, has_key: Boolean(r.has_key) }))
}

export const loadModels = async (db: D1Database) => {
  const { results } = await db.prepare(
    `SELECT m.*, p.name AS provider_name, p.slug AS provider_slug
       FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id
      ORDER BY p.sort_order, m.name`
  ).all<any>()
  return results || []
}

export const loadFeatureConfig = async (db: D1Database) => {
  const { results } = await db.prepare(
    `SELECT f.*, p.name AS provider_name, p.slug AS provider_slug, fp.name AS fallback_name
       FROM ai_feature_config f
       LEFT JOIN ai_providers p ON p.id = f.provider_id
       LEFT JOIN ai_providers fp ON fp.id = f.fallback_provider_id
      ORDER BY f.feature`
  ).all<any>()
  return results || []
}

export const loadAiSettings = async (db: D1Database): Promise<Record<string, string>> => {
  const { results } = await db.prepare('SELECT key, value FROM ai_settings').all<any>()
  return Object.fromEntries((results || []).map((r: any) => [r.key, r.value]))
}

export const loadRequestLogs = async (
  db: D1Database, f: { provider?: string; feature?: string; status?: string; limit?: number } = {}
) => {
  const where: string[] = []
  const args: any[] = []
  if (f.provider) { where.push('r.provider_slug = ?'); args.push(f.provider) }
  if (f.feature) { where.push('r.feature = ?'); args.push(f.feature) }
  if (f.status) { where.push('r.status = ?'); args.push(f.status) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const { results } = await db.prepare(
    `SELECT r.*, u.name AS user_name
       FROM ai_requests r LEFT JOIN users u ON u.id = r.user_id
       ${clause} ORDER BY r.id DESC LIMIT ?`
  ).bind(...args, Math.min(200, f.limit || 60)).all<any>()
  return results || []
}

export const loadAiAuditLog = async (db: D1Database) => {
  const { results } = await db.prepare(
    `SELECT a.*, u.name AS actor_name FROM ai_audit a
       LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 60`
  ).all<any>()
  return results || []
}

export const loadAiCounts = async (db: D1Database) => {
  const row = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM ai_providers WHERE enabled = 1) AS enabled_providers,
            (SELECT COUNT(*) FROM ai_providers) AS total_providers,
            (SELECT COUNT(*) FROM ai_feature_config WHERE provider_id IS NOT NULL) AS routed_features,
            (SELECT COUNT(*) FROM ai_models) AS total_models,
            (SELECT COUNT(*) FROM ai_requests WHERE status = 'error') AS failed_requests`
  ).first<any>()
  return {
    enabledProviders: Number(row?.enabled_providers || 0),
    totalProviders: Number(row?.total_providers || 0),
    routedFeatures: Number(row?.routed_features || 0),
    totalModels: Number(row?.total_models || 0),
    failedRequests: Number(row?.failed_requests || 0)
  }
}
