/**
 * Phase 1 — PII masking service (N3, N4).
 *
 * N3 requires protected and proxy attributes to be masked *before AI scoring*
 * and never used as scoring inputs. This service is the single place that does
 * it, and it is deliberately broader than the email/phone gate in the AI gateway
 * (which only handled contact details).
 *
 * Two distinct operations:
 *   maskForScoring()  — removes protected attributes from text that will be sent
 *                       to a model or used as a scoring input.
 *   protectedAttributeKeys() — the denylist scoring must never read, so a
 *                       dimension can be rejected rather than silently scored.
 */

/** Attributes that must never influence a screening score (N3). */
export const PROTECTED_ATTRIBUTES = [
  'name', 'first_name', 'last_name', 'full_name', 'photo', 'image', 'avatar',
  'gender', 'sex', 'age', 'date_of_birth', 'dob', 'birth_date',
  'marital_status', 'marital', 'religion', 'caste', 'community',
  'nationality', 'citizenship', 'address', 'address_detail',
  'email', 'phone', 'mobile', 'contact'
] as const

export type ProtectedAttribute = typeof PROTECTED_ATTRIBUTES[number]

const PROTECTED_SET = new Set<string>(PROTECTED_ATTRIBUTES)

/**
 * True when a field may not be used as a scoring input.
 * Also catches suffixed variants (e.g. `candidate_name`, `user_email`).
 */
export const isProtectedAttribute = (key: string): boolean => {
  const k = String(key || '').toLowerCase().trim()
  if (!k) return false
  if (PROTECTED_SET.has(k)) return true
  return PROTECTED_ATTRIBUTES.some((p) => k.endsWith(`_${p}`) || k.startsWith(`${p}_`))
}

/** Read the protected keys present on an object — used to prove masking works. */
export const protectedAttributeKeys = (obj: Record<string, any>): string[] =>
  Object.keys(obj || {}).filter(isProtectedAttribute)

/* ------------------------------------------------------------------ patterns */
// A candidate's own name cannot be regex-detected reliably, so it is removed by
// exact token match using the profile we already hold (see maskForScoring).
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/g
const URL_PROFILE_RE = /https?:\/\/(?:www\.)?(?:linkedin|github|gitlab|leetcode|naukri|indeed)\.[^\s]+/gi
const DOB_RE = /\b(?:0?[1-9]|[12]\d|3[01])[\/\-.](?:0?[1-9]|1[0-2])[\/\-.](?:19|20)\d{2}\b/g
const AGE_RE = /\b(?:age\s*[:\-]?\s*)?(\d{1,2})\s*(?:years?\s*old|yrs?\s*old)\b/gi
const MARITAL_RE = /\b(?:married|unmarried|single|divorced|widowed|separated)\b/gi
const GENDER_RE = /\b(?:male|female|non-?binary|transgender|man|woman)\b/gi
const RELIGION_RE = /\b(?:hindu|muslim|christian|sikh|buddhist|jain|parsi|jewish|atheist)\b/gi
const CASTE_RE = /\b(?:general|obc|sc|st|ews|forward caste|backward class)\b/gi
const NATIONALITY_RE = /\b(?:indian|american|british|chinese|pakistani|bangladeshi|nepali|sri lankan)\s+(?:national|citizen|citizenship)\b/gi
const ADDRESS_RE = /\b(?:address|residing at|residence|permanent address|current address)\s*[:\-]?\s*[^\n.]{5,120}/gi

export interface MaskResult {
  text: string
  redactions: { kind: string; count: number }[]
  total: number
}

/**
 * Mask protected attributes out of free text.
 *
 * `knownNames` lets us strip the candidate's own name, which no reliable pattern
 * can detect. Callers pass the profile name(s) they hold for that candidate.
 */
export const maskForScoring = (text: string, knownNames: string[] = []): MaskResult => {
  let out = String(text || '')
  const redactions: { kind: string; count: number }[] = []

  const apply = (kind: string, re: RegExp, replacement: string) => {
    const matches = out.match(re)
    if (matches && matches.length) {
      redactions.push({ kind, count: matches.length })
      out = out.replace(re, replacement)
    }
  }

  // Named entities first — longest first so "John Doe" is removed before "John".
  const names = knownNames
    .filter((n) => n && String(n).trim().length > 2)
    .map((n) => String(n).trim())
    .sort((a, b) => b.length - a.length)

  for (const name of names) {
    const parts = name.split(/\s+/).filter(Boolean)
    const variants = new Set<string>([name, ...parts.filter((p) => p.length > 2)])
    for (const v of variants) {
      const re = new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
      const hits = out.match(re)
      if (hits && hits.length) {
        redactions.push({ kind: 'name', count: hits.length })
        out = out.replace(re, '[name]')
      }
    }
  }

  apply('email', EMAIL_RE, '[email]')
  apply('phone', PHONE_RE, '[phone]')
  apply('profile_url', URL_PROFILE_RE, '[profile]')
  apply('date_of_birth', DOB_RE, '[date_of_birth]')
  apply('age', AGE_RE, '[age]')
  apply('marital_status', MARITAL_RE, '[marital_status]')
  apply('gender', GENDER_RE, '[gender]')
  apply('religion', RELIGION_RE, '[religion]')
  apply('caste', CASTE_RE, '[caste]')
  apply('nationality', NATIONALITY_RE, '[nationality]')
  apply('address', ADDRESS_RE, '[address]')

  const total = redactions.reduce((s, r) => s + r.count, 0)
  return { text: out, redactions, total }
}

/**
 * Build a scoring-safe projection of a candidate profile.
 * Protected keys are dropped entirely (not blanked) so a scorer cannot read them
 * even by accident, and free-text fields are masked.
 */
export const safeProfile = (candidate: Record<string, any>): Record<string, any> => {
  const names = [
    candidate.first_name, candidate.last_name,
    [candidate.first_name, candidate.last_name].filter(Boolean).join(' ')
  ].filter(Boolean) as string[]

  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(candidate || {})) {
    if (isProtectedAttribute(k)) continue
    if (typeof v === 'string' && (k === 'summary' || k === 'headline' || k === 'resume_text')) {
      out[k] = maskForScoring(v, names).text
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * Guard used by the scoring engine: refuse to score a dimension whose inputs
 * include a protected attribute. Throws rather than silently ignoring, so a
 * misconfiguration is visible in tests instead of quietly biasing results.
 */
export const assertNoProtectedInputs = (dimension: string, inputs: String[] | Record<string, any>): void => {
  const keys = Array.isArray(inputs) ? inputs.map(String) : Object.keys(inputs)
  const bad = keys.filter(isProtectedAttribute)
  if (bad.length) {
    const err: any = new Error(
      `protected_attribute_used: dimension "${dimension}" cannot read ${bad.join(', ')} (rule N3)`
    )
    err.code = 'protected_attribute_used'
    err.status = 422
    throw err
  }
}
