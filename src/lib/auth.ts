import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { can, type Permission, type Role } from './rbac'
import { nowIso, addDays } from './util'

export type Bindings = {
  DB: D1Database
  ENVIRONMENT?: string
  APP_NAME?: string
  MAIL_PROVIDER?: string
}

export type AuthUser = {
  id: number
  email: string
  name: string
  role: Role
  title: string | null
  department: string | null
  /** N5/D10 — every authenticated request carries its tenant. */
  tenant_id: number
  tenant_region: string
}

export type AppEnv = { Bindings: Bindings; Variables: { user: AuthUser | null } }

const SESSION_COOKIE = 'ats_session'
const ITERATIONS = 60_000

const enc = new TextEncoder()

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array((hex.match(/.{1,2}/g) || []).map((b) => parseInt(b, 16)))

export const hashPassword = async (password: string): Promise<string> => {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256
  )
  return `pbkdf2$${ITERATIONS}$${toHex(salt.buffer as ArrayBuffer)}$${toHex(bits)}`
}

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$')
  if (parts.length !== 4) return false
  const iterations = Number(parts[1])
  const salt = fromHex(parts[2])
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  )
  return toHex(bits) === parts[3]
}

export const randomToken = (): string =>
  [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')

export const createSession = async (db: D1Database, userId: number): Promise<string> => {
  const token = randomToken()
  await db
    .prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, addDays(nowIso(), 7))
    .run()
  return token
}

export const setSessionCookie = (c: Context, token: string) => {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7
  })
}

export const clearSession = async (c: Context, token: string | undefined) => {
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

export const loadUser = async (c: Context<AppEnv>): Promise<AuthUser | null> => {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return null
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.title, u.department,
            u.tenant_id, COALESCE(t.region,'IN') AS tenant_region
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE s.token = ? AND s.expires_at > ? AND u.active = 1
        AND COALESCE(t.status,'active') = 'active'`
  )
    .bind(token, nowIso())
    .first<any>()
  if (!row) return null
  return {
    ...row,
    tenant_id: Number(row.tenant_id || 1),
    tenant_region: row.tenant_region || 'IN'
  } as AuthUser
}

/** Populates c.get('user'); does not block. */
export const withUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await loadUser(c)
  c.set('user', user)
  await next()
}

export const currentUser = (c: Context<AppEnv>): AuthUser => {
  const u = c.get('user') as AuthUser | null
  if (!u) throw new Error('unauthenticated')
  return u
}

export const API_PREFIXES = ['/api/']

const isApi = (path: string) => path.startsWith('/api/')

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await loadUser(c)
  if (!user) {
    if (isApi(c.req.path)) {
      return c.json({ error: 'unauthorized', message: 'Sign in required' }, 401)
    }
    const next_ = encodeURIComponent(c.req.path)
    return c.redirect(`/login?next=${next_}`)
  }
  c.set('user', user)
  await next()
}

export const requirePermission = (...perms: Permission[]): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const user = await loadUser(c)
    if (!user) {
      if (isApi(c.req.path)) return c.json({ error: 'unauthorized' }, 401)
      return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`)
    }
    const missing = perms.filter((p) => !can(user.role, p))
    if (missing.length) {
      if (isApi(c.req.path)) {
        return c.json({ error: 'forbidden', message: 'Missing permission', required: missing, role: user.role }, 403)
      }
      return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>Forbidden</title>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.2/css/all.min.css" rel="stylesheet">
        <link href="/static/app.css" rel="stylesheet"></head>
        <body><div style="max-width:520px;margin:14vh auto;text-align:center;padding:0 20px">
        <i class="fa-solid fa-lock" style="font-size:34px;color:#98a2b3"></i>
        <h1 style="margin-top:16px">Access restricted</h1>
        <p class="muted">Your role (<b>${user.role}</b>) does not include: <span class="mono">${missing.join(', ')}</span></p>
        <a class="btn primary" href="/" style="margin-top:12px">Back to dashboard</a>
        </div></body></html>`, 403)
    }
    c.set('user', user)
    await next()
  }
}

/** Row-level guard used by resource handlers. */
export const assertJobAccess = async (c: Context<AppEnv>, jobId: number): Promise<boolean> => {
  const user = currentUser(c)
  if (user.role !== 'hiring_manager') return true
  const row = await c.env.DB.prepare('SELECT hiring_manager_id, recruiter_id FROM jobs WHERE id = ?')
    .bind(jobId)
    .first<any>()
  if (!row) return false
  return row.hiring_manager_id === user.id
}

export const assertApplicationAccess = async (c: Context<AppEnv>, applicationId: number): Promise<boolean> => {
  const user = currentUser(c)
  if (user.role === 'hiring_manager') {
    const row = await c.env.DB.prepare(
      'SELECT j.hiring_manager_id FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?'
    )
      .bind(applicationId)
      .first<any>()
    return !!row && row.hiring_manager_id === user.id
  }
  if (user.role === 'interviewer') {
    const row = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM interviews i JOIN interview_participants p ON p.interview_id = i.id
        WHERE i.application_id = ? AND p.user_id = ? LIMIT 1`
    )
      .bind(applicationId, user.id)
      .first<any>()
    return !!row
  }
  return true
}
