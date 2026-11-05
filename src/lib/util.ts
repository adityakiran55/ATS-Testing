export const nowIso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

export const addHours = (iso: string, hours: number): string =>
  new Date(new Date(iso).getTime() + hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')

export const addDays = (iso: string, days: number): string => addHours(iso, days * 24)

export const daysBetween = (fromIso: string, toIso: string): number =>
  (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86_400_000

export const hoursBetween = (fromIso: string, toIso: string): number =>
  (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000

export const fmtDate = (iso?: string | null): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export const fmtDateTime = (iso?: string | null): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false
  }) + ' UTC'
}

export const relTime = (iso?: string | null): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60000)
  const unit = mins < 60 ? [mins, 'min'] : mins < 1440 ? [Math.round(mins / 60), 'hr'] : [Math.round(mins / 1440), 'd']
  return diff >= 0 ? `${unit[0]}${unit[1]} ago` : `in ${unit[0]}${unit[1]}`
}

export const titleCase = (s?: string | null): string => {
  if (!s) return '—'
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export const money = (n?: number | null, currency = 'USD'): string => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, maximumFractionDigits: 0
  }).format(n)
}

export const initials = (first?: string | null, last?: string | null): string =>
  `${(first || '?')[0] || ''}${(last || '')[0] || ''}`.toUpperCase()

export const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export const normEmail = (e?: string | null): string => (e || '').trim().toLowerCase()

export const normPhone = (p?: string | null): string => (p || '').replace(/\D/g, '')

export const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

/** Deterministic non-crypto hash, used for idempotency keys and input fingerprints. */
export const hashString = (s: string): string => {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(12, '0')
}

export const truncate = (s: string | null | undefined, n = 160): string => {
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s
}

export const paginate = (items: any[], page: number, perPage: number) => {
  const total = items.length
  const pages = Math.max(1, Math.ceil(total / perPage))
  const p = Math.min(Math.max(1, page), pages)
  return { items: items.slice((p - 1) * perPage, p * perPage), page: p, pages, total }
}

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

export const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10)
