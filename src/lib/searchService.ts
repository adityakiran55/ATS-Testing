import { nowIso, parseJson, pct, truncate } from './util'
import { runBoolean, runSemantic, expandQuery, type SearchDoc } from './search'

export type SearchParams = {
  q?: string
  mode?: 'boolean' | 'semantic'
  skills?: string
  location?: string
  minExperience?: number
  maxExperience?: number
  maxNotice?: number
  maxSalary?: number
  tags?: string
  consent?: string
  poolId?: number
  appliedToJobId?: number
  hasApplications?: boolean
  sort?: string
  page?: number
  perPage?: number
}

type Row = SearchDoc & {
  first_name: string
  last_name: string
  email: string
  phone: string | null
  location: string | null
  headline: string | null
  current_employer: string | null
  education: string | null
  experience_years: number | null
  notice_period_days: number | null
  expected_salary: number | null
  consent_status: string
  status: string
  source: string | null
  created_at: string
  tag_names: string | null
  application_count: number
  last_application: string | null
}

/**
 * ATS-01 / ATS-13 candidate search.
 * One pass over candidate_index drives both Boolean and semantic matching, and
 * the matched terms become the "why this matched" explanation shown in the UI.
 */
export const searchCandidates = async (
  db: D1Database,
  params: SearchParams,
  userId?: number,
  options: { audit?: boolean } = {}
) => {
  const started = Date.now()
  const mode = params.mode === 'semantic' ? 'semantic' : 'boolean'
  const page = Math.max(1, params.page || 1)
  const perPage = Math.min(200, Math.max(1, params.perPage || 25))

  const { results } = await db
    .prepare(
      `SELECT c.id AS candidate_id, c.*, ci.search_blob, ci.skills, ci.titles, ci.employers,
              ci.education AS idx_education, ci.locations, ci.resume_text,
              (SELECT GROUP_CONCAT(t.name, '|') FROM candidate_tags ct JOIN tags t ON t.id = ct.tag_id
                WHERE ct.candidate_id = c.id) AS tag_names,
              (SELECT COUNT(*) FROM applications a WHERE a.candidate_id = c.id) AS application_count,
              (SELECT MAX(a.applied_at) FROM applications a WHERE a.candidate_id = c.id) AS last_application
         FROM candidates c
         LEFT JOIN candidate_index ci ON ci.candidate_id = c.id
        WHERE c.status = 'active'`
    )
    .all<any>()

  let rows: Row[] = results as Row[]

  /* ---------------------------------------------------------- filters */
  if (params.consent) rows = rows.filter((r) => r.consent_status === params.consent)

  if (params.location) {
    const needle = params.location.toLowerCase()
    rows = rows.filter((r) =>
      (r.location || '').toLowerCase().includes(needle) || (r.locations || '').toLowerCase().includes(needle)
    )
  }
  if (params.skills) {
    const wanted = params.skills.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    if (wanted.length) {
      rows = rows.filter((r) => {
        const hay = `${r.skills || ''} ${r.titles || ''} ${r.resume_text || ''}`.toLowerCase()
        return wanted.every((w) => hay.includes(w))
      })
    }
  }
  if (params.minExperience !== undefined) rows = rows.filter((r) => (r.experience_years || 0) >= params.minExperience!)
  if (params.maxExperience !== undefined) rows = rows.filter((r) => (r.experience_years || 0) <= params.maxExperience!)
  if (params.maxNotice !== undefined) {
    rows = rows.filter((r) => r.notice_period_days === null || r.notice_period_days <= params.maxNotice!)
  }
  if (params.maxSalary !== undefined) {
    rows = rows.filter((r) => r.expected_salary === null || r.expected_salary <= params.maxSalary!)
  }
  if (params.tags) {
    const wanted = params.tags.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    rows = rows.filter((r) => wanted.every((w) => (r.tag_names || '').toLowerCase().includes(w)))
  }
  if (params.poolId) {
    const { results: members } = await db
      .prepare('SELECT candidate_id FROM talent_pool_members WHERE pool_id = ?')
      .bind(params.poolId)
      .all<any>()
    const allowed = new Set(members.map((m: any) => m.candidate_id))
    rows = rows.filter((r) => allowed.has(r.candidate_id))
  }
  if (params.appliedToJobId) {
    const { results: apps } = await db
      .prepare('SELECT candidate_id FROM applications WHERE job_id = ?')
      .bind(params.appliedToJobId)
      .all<any>()
    const allowed = new Set(apps.map((a: any) => a.candidate_id))
    rows = rows.filter((r) => allowed.has(r.candidate_id))
  }
  if (params.hasApplications) rows = rows.filter((r) => r.application_count > 0)

  /* ------------------------------------------------------ text matching */
  const query = (params.q || '').trim()
  const scored: any[] = []

  for (const r of rows) {
    const doc: SearchDoc = {
      candidate_id: r.candidate_id,
      search_blob: `${r.search_blob || ''} ${r.tag_names || ''}`.trim(),
      skills: r.skills || '',
      titles: r.titles || '',
      employers: r.employers || '',
      education: r.idx_education || r.education || '',
      locations: r.locations || r.location || '',
      resume_text: r.resume_text || ''
    }

    let matchReasons: string[] = []
    let semanticScore = 0
    let matchedField = ''
    let keep = true

    if (query) {
      if (mode === 'semantic') {
        const sm = runSemantic(query, doc)
        semanticScore = sm.score
        matchedField = sm.matchedField
        matchReasons = sm.matchedTerms.slice(0, 6)
        keep = sm.score >= 0.12
      } else {
        const bm = runBoolean(query, doc)
        matchReasons = bm.reasons
        keep = bm.matched
      }
    }

    if (!keep) continue

    scored.push({
      ...r,
      tags: (r.tag_names || '').split('|').filter(Boolean),
      match_reasons: matchReasons,
      semantic_score: semanticScore,
      matched_field: matchedField,
      application_count: Number(r.application_count || 0)
    })
  }

  /* --------------------------------------------------------------- sort */
  const sort = params.sort || (mode === 'semantic' && query ? 'relevance' : 'recent')
  const sorted = [...scored]
  switch (sort) {
    case 'relevance':
      sorted.sort((a, b) => (b.semantic_score || 0) - (a.semantic_score || 0) || (b.match_reasons.length - a.match_reasons.length))
      break
    case 'experience':
      sorted.sort((a, b) => (b.experience_years || 0) - (a.experience_years || 0))
      break
    case 'name':
      sorted.sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`))
      break
    case 'applications':
      sorted.sort((a, b) => b.application_count - a.application_count)
      break
    case 'salary':
      sorted.sort((a, b) => (a.expected_salary || 9e9) - (b.expected_salary || 9e9))
      break
    case 'recent':
    default:
      sorted.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  }

  const total = sorted.length
  const pages = Math.max(1, Math.ceil(total / perPage))
  const safePage = Math.min(page, pages)
  const pageRows = sorted.slice((safePage - 1) * perPage, safePage * perPage)

  const results2 = pageRows.map((r) => ({
    id: r.candidate_id,
    first_name: r.first_name,
    last_name: r.last_name,
    email: r.email,
    phone: r.phone,
    location: r.location,
    headline: r.headline,
    current_employer: r.current_employer,
    education: r.education,
    experience_years: r.experience_years,
    notice_period_days: r.notice_period_days,
    expected_salary: r.expected_salary,
    consent_status: r.consent_status,
    source: r.source,
    status: r.status,
    created_at: r.created_at,
    skills: (r.skills || '').split(',').map((s: string) => s.trim()).filter(Boolean),
    tags: r.tags,
    application_count: r.application_count,
    last_application: r.last_application,
    match_reasons: r.match_reasons,
    semantic_score: r.semantic_score,
    matched_field: r.matched_field
  }))

  const durationMs = Date.now() - started

  if (options.audit !== false && userId) {
    await db
      .prepare(
        `INSERT INTO search_audit (user_id, query, mode, filters, result_count, duration_ms, created_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .bind(
        userId, query || null, mode,
        JSON.stringify({
          skills: params.skills || null, location: params.location || null,
          minExperience: params.minExperience ?? null, maxNotice: params.maxNotice ?? null,
          maxSalary: params.maxSalary ?? null, tags: params.tags || null,
          consent: params.consent || null, poolId: params.poolId ?? null,
          appliedToJobId: params.appliedToJobId ?? null, sort
        }),
        total, durationMs, nowIso()
      )
      .run()
  }

  return {
    results: results2,
    total,
    page: safePage,
    pages,
    per_page: perPage,
    mode,
    query,
    sort,
    duration_ms: durationMs,
    /** Human-readable plan for semantic queries, so the UI can show why results matched. */
    plan: mode === 'semantic' && query
      ? {
          original: query,
          interpreted_terms: expandQuery(query).slice(0, 10),
          explanation:
            'Query normalised (stop-words removed, terms stemmed), expanded with the role synonym dictionary, ' +
            'then scored by weighted term overlap across skills, titles, employers, education and resume text.',
          can_refine: ['add location filter', 'require minimum experience', 'restrict to talent pool']
        }
      : null
  }
}

/* ------------------------------------------------- rediscovery heuristic */
/** Surfaces previously-seen candidates who never applied to this requisition. */
export const rediscoverForJob = async (db: D1Database, jobId: number, limit = 12) => {
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<any>()
  if (!job) return { job: null, candidates: [] }
  const must = parseJson<string[]>(job.must_have_skills, [])

  const { results } = await db
    .prepare(
      `SELECT c.id, c.first_name, c.last_name, c.headline, c.location, c.experience_years,
              c.expected_salary, c.consent_status, c.last_application_hint,
              ci.skills, ci.titles,
              (SELECT COUNT(*) FROM applications a WHERE a.candidate_id = c.id) AS app_count
         FROM candidates c LEFT JOIN candidate_index ci ON ci.candidate_id = c.id
        WHERE c.status = 'active'
          AND c.id NOT IN (SELECT candidate_id FROM applications WHERE job_id = ?)
          AND (SELECT COUNT(*) FROM applications a WHERE a.candidate_id = c.id) > 0`
    )
    .bind(jobId)
    .all<any>()

  const ranked = results
    .map((r: any) => {
      const hay = `${r.skills || ''} ${r.titles || ''} ${r.headline || ''}`.toLowerCase()
      const hits = must.filter((m) => hay.includes(m.toLowerCase()))
      return {
        ...r,
        matched_skills: hits,
        overlap: must.length ? hits.length / must.length : 0,
        app_count: Number(r.app_count || 0)
      }
    })
    .filter((r: any) => r.overlap > 0)
    .sort((a: any, b: any) => b.overlap - a.overlap || b.app_count - a.app_count)
    .slice(0, limit)

  return {
    job: { id: job.id, title: job.title, must_have: must },
    candidates: ranked.map((r: any) => ({ ...r, overlap_pct: Math.round(r.overlap * 100) }))
  }
}
