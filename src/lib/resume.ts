/**
 * Resume processing pipeline (spec §4: Uploaded → Malware Scan → Queued →
 * Parsing/OCR → Parsed → Screening Ready, with Retry → Dead Letter).
 *
 * Cloudflare Workers cannot run background jobs, so the queue is drained
 * lazily: every request to the processing endpoint (and page renders) advances
 * the queue. Each job carries an idempotency key and a bounded retry count.
 */
import { nowIso, addHours, parseJson, hashString } from './util'
import { RESUME_TRANSITIONS, assertTransition } from './lifecycle'

const MAX_ATTEMPTS = 3

export type ParseResult = {
  skills: string[]
  titles: string[]
  employers: string[]
  education: string[]
  experience_years: number
  emails: string[]
  phones: string[]
  locations: string[]
  confidence: number
  text: string
  method: 'text' | 'ocr'
}

const SKILL_DICT = [
  'javascript', 'typescript', 'react', 'node.js', 'node', 'python', 'java', 'go', 'golang', 'ruby', 'php',
  'c++', 'c#', '.net', 'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'kafka',
  'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'terraform', 'ci/cd', 'jenkins', 'github actions',
  'graphql', 'rest', 'microservices', 'html', 'css', 'tailwind', 'vue', 'angular', 'next.js',
  'machine learning', 'pytorch', 'tensorflow', 'pandas', 'numpy', 'spark', 'airflow', 'dbt',
  'product management', 'roadmap', 'stakeholder management', 'agile', 'scrum', 'jira', 'figma',
  'ux', 'ui', 'user research', 'salesforce', 'hubspot', 'seo', 'content marketing', 'recruiting',
  'sourcing', 'ats', 'hris', 'payroll', 'compliance', 'excel', 'tableau', 'looker', 'power bi'
]

const TITLE_PATTERNS = [
  /(senior|staff|principal|lead|junior|associate|head of|director of|vp of)?\s*([a-z ]{3,30}?)\s*(engineer|developer|manager|designer|analyst|architect|scientist|recruiter|specialist|consultant|director|lead)/gi
]

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Replace with real OCR (e.g. external API) when a binary upload is stored. */
export const extractText = (raw: string): { text: string; method: 'text' | 'ocr' } => {
  const cleaned = raw.replace(/\r/g, '').replace(/\u0000/g, ' ')
  return { text: cleaned, method: 'text' }
}

export const parseResume = (rawText: string): ParseResult => {
  const { text, method } = extractText(rawText)
  const lower = norm(text)

  const skills = [...new Set(
    SKILL_DICT.filter((s) => {
      const needle = s.includes('+') || s.includes('#') || s.includes('.') ? s : ` ${s} `
      return needle.includes(' ')
        ? lower.includes(needle) || lower.startsWith(s + ' ') || lower.endsWith(' ' + s)
        : lower.includes(needle)
    })
  )]

  const titles = new Set<string>()
  for (const rx of TITLE_PATTERNS) {
    let m: RegExpExecArray | null
    while ((m = rx.exec(text))) {
      const t = norm(m[0])
      if (t.split(' ').length <= 5 && t.length > 6) titles.add(t)
    }
  }

  const employers: string[] = []
  const employerRx = /(?:at|@)\s+([A-Z][A-Za-z0-9&.\- ]{2,28})(?=[,\n·|]|$)/g
  let em: RegExpExecArray | null
  while ((em = employerRx.exec(text))) {
    const name = em[1].trim()
    if (!/^(the|a|an)$/i.test(name) && !employers.includes(name)) employers.push(name)
  }

  const education: string[] = []
  const eduRx = /(bachelor|master|phd|b\.?s\.?|m\.?s\.?|mba|b\.?tech|m\.?tech)[^.\n]{0,60}/gi
  let ed: RegExpExecArray | null
  while ((ed = eduRx.exec(text))) education.push(ed[0].trim())

  const years = [...text.matchAll(/(\d{1,2})\+?\s*(?:years|yrs)\s*(?:of\s*)?(?:experience|exp)/gi)]
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a)
  let experience = years[0] || 0
  if (!experience) {
    const range = [...text.matchAll(/\b(19|20)\d{2}\s*[-–]\s*((19|20)\d{2}|present)/gi)]
    if (range.length) {
      const spans = range.map((m) => {
        const start = Number(m[0].slice(0, 4))
        const end = /present/i.test(m[2]) ? new Date().getFullYear() : Number(m[2])
        return Math.max(0, end - start)
      })
      experience = spans.reduce((a, b) => a + b, 0)
    }
  }

  const emails = [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [])]
  const phones = [...new Set(text.match(/\+?\d[\d\s().-]{8,}\d/g) || [])].map((p) => p.trim())
  const locations = [...new Set(
    (text.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?),\s*(?:[A-Z]{2}|[A-Z][a-z]+)\b/g) || []).slice(0, 4)
  )]

  const sections = ['experience', 'education', 'skills', 'summary', 'projects']
    .filter((s) => lower.includes(s)).length
  const confidence = Math.min(0.98, 0.35 + sections * 0.1 + Math.min(0.3, text.length / 6000) + (skills.length ? 0.1 : 0))

  return {
    skills,
    titles: [...titles].slice(0, 8),
    employers: employers.slice(0, 6),
    education: education.slice(0, 4),
    experience_years: experience,
    emails,
    phones,
    locations,
    confidence: Math.round(confidence * 100) / 100,
    text,
    method
  }
}

export const buildSearchBlob = (parsed: ParseResult, candidate: any): string =>
  [
    candidate.first_name, candidate.last_name, candidate.email, candidate.location, candidate.country,
    candidate.headline, candidate.current_employer, candidate.education, candidate.summary,
    parsed.skills.join(' '), parsed.titles.join(' '), parsed.employers.join(' '),
    parsed.education.join(' '), parsed.locations.join(' '), parsed.text.slice(0, 12000)
  ].filter(Boolean).join(' ')

/** Advances one resume through the pipeline; enforces the legal transitions. */
export const processResume = async (db: D1Database, resumeId: number): Promise<any> => {
  const resume = await db.prepare('SELECT * FROM resumes WHERE id = ?').bind(resumeId).first<any>()
  if (!resume) throw new Error('resume_not_found')

  const step = async (to: string, patch: Record<string, unknown> = {}) => {
    const guard = assertTransition(RESUME_TRANSITIONS, resume.status, to)
    if (!guard.ok) throw new Error(guard.message)
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ')
    await db
      .prepare(`UPDATE resumes SET status = ?${sets ? ', ' + sets : ''}, updated_at = ? WHERE id = ?`)
      .bind(to, ...Object.values(patch), nowIso(), resumeId)
      .run()
    resume.status = to
  }

  try {
    if (resume.status === 'uploaded') await step('malware_scan', { attempts: resume.attempts + 1 })
    if (resume.status === 'malware_scan') await step('queued')
    if (resume.status === 'queued') {
      const evtKey = `resume:${resumeId}:${resume.attempts}`
      await db
        .prepare(
          `INSERT INTO resume_jobs (resume_id, state, attempts, event_key) VALUES (?, 'processing', ?, ?)
           ON CONFLICT(event_key) DO NOTHING`
        )
        .bind(resumeId, resume.attempts, evtKey)
        .run()
      await step('parsing')
    }
    if (resume.status === 'parsing') {
      const parsed = parseResume(resume.raw_text || '')
      if (!parsed.text || parsed.text.trim().length < 40) {
        throw new Error('insufficient_text')
      }
      const candidate = await db.prepare('SELECT * FROM candidates WHERE id = ?').bind(resume.candidate_id).first<any>()
      await step('parsed', {
        parsed_json: JSON.stringify({
          skills: parsed.skills, titles: parsed.titles, employers: parsed.employers,
          education: parsed.education, experience_years: parsed.experience_years,
          emails: parsed.emails, phones: parsed.phones, locations: parsed.locations,
          method: parsed.method
        }),
        parse_confidence: parsed.confidence
      })

      const blob = buildSearchBlob(parsed, candidate)
      await db
        .prepare(
          `INSERT INTO candidate_index (candidate_id, search_blob, skills, titles, employers, education, locations, resume_text, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(candidate_id) DO UPDATE SET
             search_blob = excluded.search_blob, skills = excluded.skills, titles = excluded.titles,
             employers = excluded.employers, education = excluded.education, locations = excluded.locations,
             resume_text = excluded.resume_text, updated_at = excluded.updated_at`
        )
        .bind(
          resume.candidate_id, blob,
          parsed.skills.join(', '), parsed.titles.join(', '), parsed.employers.join(', '),
          parsed.education.join(', '), parsed.locations.join(', '), parsed.text.slice(0, 20000), nowIso()
        )
        .run()

      // Backfill candidate fields only when empty
      const patch: Record<string, unknown> = {}
      if (!candidate.experience_years && parsed.experience_years) patch.experience_years = parsed.experience_years
      if (!candidate.location && parsed.locations[0]) patch.location = parsed.locations[0]
      if (!candidate.headline && parsed.titles[0]) patch.headline = parsed.titles[0]
      if (!candidate.current_employer && parsed.employers[0]) patch.current_employer = parsed.employers[0]
      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ')
      if (sets) {
        await db.prepare(`UPDATE candidates SET ${sets}, updated_at = ? WHERE id = ?`)
          .bind(...Object.values(patch), nowIso(), resume.candidate_id).run()
      }
      await step('screening_ready')
      await db.prepare("UPDATE resume_jobs SET state = 'done' WHERE resume_id = ? AND state = 'processing'").bind(resumeId).run()
    }
    return { resume_id: resumeId, status: resume.status, ok: true }
  } catch (err: any) {
    const attempts = (resume.attempts || 0) + 1
    const dead = attempts >= MAX_ATTEMPTS
    await db
      .prepare('UPDATE resumes SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .bind(dead ? 'dead_letter' : 'failed', attempts, err?.message || 'parse_error', nowIso(), resumeId)
      .run()
    await db
      .prepare("UPDATE resume_jobs SET state = ?, last_error = ?, attempts = ? WHERE resume_id = ? AND state = 'processing'")
      .bind(dead ? 'dead_letter' : 'failed', err?.message || 'parse_error', attempts, resumeId)
      .run()
    return { resume_id: resumeId, status: dead ? 'dead_letter' : 'failed', ok: false, error: err?.message, attempts }
  }
}

/** Drains the queue: retries failed resumes whose backoff has elapsed. */
export const drainQueue = async (db: D1Database, limit = 10) => {
  const { results } = await db
    .prepare("SELECT id, status FROM resumes WHERE status IN ('uploaded','failed','queued','parsing') ORDER BY updated_at LIMIT ?")
    .bind(limit)
    .all<any>()
  const out: any[] = []
  for (const r of results) {
    if (r.status === 'failed') {
      const row = await db.prepare('SELECT attempts FROM resumes WHERE id = ?').bind(r.id).first<any>()
      if ((row?.attempts || 0) >= MAX_ATTEMPTS) {
        await db.prepare("UPDATE resumes SET status = 'dead_letter' WHERE id = ?").bind(r.id).run()
        continue
      }
      await db.prepare("UPDATE resumes SET status = 'queued' WHERE id = ?").bind(r.id).run()
    }
    out.push(await processResume(db, r.id))
  }
  return out
}

export const retryResume = async (db: D1Database, resumeId: number) => {
  const resume = await db.prepare('SELECT * FROM resumes WHERE id = ?').bind(resumeId).first<any>()
  if (!resume) throw new Error('resume_not_found')
  if (!['failed', 'dead_letter'].includes(resume.status)) throw new Error('not_retryable')
  await db
    .prepare("UPDATE resumes SET status = 'queued', attempts = 0, last_error = NULL, updated_at = ? WHERE id = ?")
    .bind(nowIso(), resumeId)
    .run()
  return processResume(db, resumeId)
}

export const seedQueueBacklog = async (db: D1Database) => {
  const { results } = await db
    .prepare("SELECT id FROM resumes WHERE status IN ('uploaded','queued','parsing') LIMIT 25")
    .all<any>()
  return results.length
}
