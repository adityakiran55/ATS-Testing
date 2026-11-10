/**
 * Secret encryption for AI provider credentials.
 *
 * Cloudflare Workers has no filesystem, so there is no `.env` to write and no
 * keyfile to chmod. Secrets are encrypted at rest in D1 with AES-GCM and the
 * key material never leaves the Worker runtime.
 *
 * Resolution order for the master key:
 *   1. env.AI_ENCRYPTION_KEY  (wrangler secret / .dev.vars) — production path
 *   2. a per-installation random key derived from the D1-stored salt — so a fresh
 *      install works with zero manual configuration (dev / first boot).
 *
 * Ciphertext and IV are stored separately and never returned to a client. The
 * only credential material that reaches the browser is `api_key_hint` (last 4).
 */

const ALGO = 'AES-GCM'
const IV_BYTES = 12

const b64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

const unb64 = (s: string): Uint8Array => {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const enc = new TextEncoder()

/** Build a 256-bit AES key from an arbitrary secret string. */
const deriveKey = async (secret: string): Promise<CryptoKey> => {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('vsolutions-ats.ai.v1'), iterations: 100_000, hash: 'SHA-256' },
    base,
    { name: ALGO, length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Resolve the master key. `salt` is read from ai_settings so that an installation
 * without a configured secret still produces a stable, unique key.
 */
export const masterKey = async (envSecret: string | undefined, salt: string): Promise<CryptoKey> => {
  if (envSecret && envSecret.length >= 32) return deriveKey(envSecret)
  if (!salt) throw new Error('ai_encryption_unconfigured: set AI_ENCRYPTION_KEY or initialise the installer')
  return deriveKey(`vsolutions-ats-local:${salt}`)
}

export const encryptSecret = async (
  key: CryptoKey,
  plaintext: string
): Promise<{ ciphertext: string; iv: string }> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt({ name: ALGO, iv }, key, enc.encode(plaintext))
  return { ciphertext: b64(ct), iv: b64(iv) }
}

export const decryptSecret = async (
  key: CryptoKey,
  ciphertext: string,
  iv: string
): Promise<string> => {
  const pt = await crypto.subtle.decrypt({ name: ALGO, iv: unb64(iv) }, key, unb64(ciphertext))
  return new TextDecoder().decode(pt)
}

/** Last-4 hint for display. Never enough to reconstruct the key. */
export const keyHint = (plaintext: string): string =>
  plaintext.length <= 4 ? '••••' : `••••${plaintext.slice(-4)}`

/**
 * Redact anything that looks like a credential from text headed for a log,
 * an error message, or an API response.
 */
export const redact = (input: string): string =>
  String(input)
    .replace(/\b(sk|sk-ant|sk-or|xai|gsk|pplx|hf)-[A-Za-z0-9_\-]{8,}/g, '«redacted-key»')
    .replace(/\b([A-Za-z0-9_\-]{24,})\b/g, (m) => (m.length >= 32 ? '«redacted»' : m))
    .replace(/("?(?:api_?key|password|secret|token|authorization)"?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1«redacted»')
