/**
 * Phase 1 — Tenant isolation (N5, D10).
 *
 * D1 has no row-level security, so isolation is enforced in one place: every
 * tenant-scoped query goes through `scope()` / `tenantFilter()` which append a
 * `tenant_id = ?` predicate bound to the *authenticated* user's tenant.
 *
 * The rules that make this safe:
 *   - tenant_id always comes from the session, never from request input
 *   - a query helper refuses to run without a tenant argument
 *   - cross-tenant reads return "not found", not "forbidden", so ids cannot be
 *     probed (see `assertTenantRow`)
 */
import type { D1Database } from '@cloudflare/workers-types'
import type { AuthUser } from './auth'

/** Tables that carry a tenant_id column and must never be queried unscoped. */
export const TENANT_TABLES = [
  'users', 'candidates', 'jobs', 'applications', 'resumes',
  'resume_fields', 'screening_profiles', 'screening_runs', 'jd_versions',
  'jd_analyses', 'candidate_notices', 'demographic_data', 'adverse_impact_reports',
  'breach_incidents', 'processors', 'region_config', 'retention_policies',
  'pipeline_stages', 'role_definitions', 'api_tokens'
] as const

export type TenantTable = typeof TENANT_TABLES[number]

export const tenantOf = (user: AuthUser): number => Number(user.tenant_id || 1)

/**
 * Append a tenant predicate to a WHERE clause.
 * `alias` is the table alias in the surrounding query (e.g. 'c' for candidates).
 */
export const tenantFilter = (alias = ''): string => {
  const col = alias ? `${alias}.tenant_id` : 'tenant_id'
  return `${col} = ?`
}

/**
 * Scope a prepared statement to the user's tenant.
 * Usage:  db.prepare(`SELECT ... WHERE ${tenantFilter('c')} AND c.id = ?`).bind(...scope(user), id)
 */
export const scope = (user: AuthUser): [number] => [tenantOf(user)]

/**
 * Load one tenant-scoped row or fail closed.
 * Returns null when the row exists but belongs to another tenant — the caller
 * must respond 404 so that ids are not enumerable across tenants.
 */
export const findInTenant = async <T = any>(
  db: D1Database, table: TenantTable, id: number, user: AuthUser
): Promise<T | null> => {
  const row = await db
    .prepare(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ?`)
    .bind(id, tenantOf(user))
    .first<T>()
  return (row as T) || null
}

/** Count rows visible to this tenant — used by isolation tests. */
export const countForTenant = async (
  db: D1Database, table: TenantTable, tenantId: number
): Promise<number> => {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`)
    .bind(tenantId)
    .first<any>()
  return Number(row?.n || 0)
}

/**
 * Guard for mutating handlers. Resolves the row in the caller's tenant or throws
 * a typed 404 that the app turns into a JSON error.
 */
export const requireInTenant = async <T = any>(
  db: D1Database, table: TenantTable, id: number, user: AuthUser
): Promise<T> => {
  const row = await findInTenant<T>(db, table, id, user)
  if (!row) {
    const err: any = new Error('not_found')
    err.code = 'not_found'
    err.status = 404
    throw err
  }
  return row
}

export const loadTenant = async (db: D1Database, tenantId: number) =>
  db.prepare('SELECT * FROM tenants WHERE id = ?').bind(tenantId).first<any>()

export const loadTenantSettings = async (db: D1Database, tenantId: number): Promise<Record<string, any>> => {
  const t = await loadTenant(db, tenantId)
  try { return JSON.parse(t?.settings || '{}') } catch { return {} }
}
