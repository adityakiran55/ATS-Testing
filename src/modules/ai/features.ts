/**
 * ATS AI features (Part 11.E / 11.F).
 *
 * Every function here builds a prompt from real ATS data and calls the gateway.
 * Nothing calls a provider directly.
 *
 * Non-negotiable guardrails, enforced in the system prompt *and* in the shape of
 * the response we accept:
 *   - Output is advisory. It never rejects, hires, or makes a final decision.
 *   - Personal contact details are gated by the gateway's PII policy before an
 *     external call (Part 11.H).
 *   - The assistant only sees records the calling user is authorised to read.
 */
import { loadAnalytics } from '../../lib/metrics'
import { sourceInsights } from '../../lib/ai'
import { parseJson } from '../../lib/util'
import type { AuthUser } from '../../lib/auth'
import { invoke } from './gateway'
import { FEATURE_LABELS } from './types'
import type { ChatMessage, FeatureKey } from './types'

const ADVISORY_SYSTEM = `You are an assistant embedded in VSolutions ATS, a recruiting platform.

Absolute rules:
- You provide analysis and drafting support only. You never make a hiring, rejection, or
  advancement decision, and you never state that a candidate "should be rejected" or "should be hired".
- Ground every claim in the data supplied to you. If the data does not support a claim, say so.
- Where evidence is missing, name it explicitly rather than guessing.
- Never invent candidate facts, employers, dates, scores, or metrics.
- Be concise and professional. Prefer short paragraphs and bullet points over long prose.`

/** Pull a JSON object out of a model response, tolerating code fences and prose. */
const parseJsonLoose = <T = any>(text: string): T | null => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try { return JSON.parse(candidate.slice(start, end + 1)) as T } catch { return null }
}

const one = (db: D1Database, sql: string, ...args: any[]) =>
  db.prepare(sql).bind(...args).first<any>()

const all = async (db: D1Database, sql: string, ...args: any[]) =>
  (await db.prepare(sql).bind(...args).all<any>()).results || []

const candidateBlock = (c: any) => [
  `Name: ${c.first_name} ${c.last_name}`,
  `Headline: ${c.headline || '—'}`,
  `Location: ${c.location || '—'}`,
  `Current employer: ${c.current_employer || '—'}`,
  `Experience: ${c.experience_years ?? '—'} years`,
  `Education: ${c.education || '—'}`,
  `Notice period: ${c.notice_period_days ?? '—'} days`,
  `Expected salary: ${c.expected_salary ?? '—'} ${c.salary_currency || ''}`,
  `Summary: ${c.summary || '—'}`
].join('\n')

const jobBlock = (j: any) => {
  const must = parseJson<string[]>(j.must_have_skills, [])
  const nice = parseJson<string[]>(j.nice_to_have, [])
  return [
    `Title: ${j.title}`,
    `Department: ${j.department} · ${j.location} · ${j.work_mode} · ${j.employment_type}`,
    `Seniority: ${j.seniority || '—'}`,
    `Must-have skills: ${must.join(', ') || '—'}`,
    `Nice-to-have skills: ${nice.join(', ') || '—'}`,
    `Description: ${(j.description || '').slice(0, 2500) || '—'}`,
    `Requirements: ${(j.requirements || '').slice(0, 1500) || '—'}`
  ].join('\n')
}

/* ============================================================ runFeature ==== */
export interface FeatureResult {
  ok: boolean
  feature: FeatureKey
  label: string
  advisory: true
  text: string
  data: unknown
  provider: string
  model: string
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  attempts: number
  fellBack: boolean
  costUsd: number
  warnings?: string[]
}

export const runFeature = async (
  env: any, feature: FeatureKey, body: any, user: AuthUser
): Promise<FeatureResult> => {
  const db: D1Database = env.DB
  const base = { feature, label: FEATURE_LABELS[feature].label } as const

  let messages: ChatMessage[] = []
  let postProcess: (text: string) => unknown = (t) => parseJsonLoose(t) ?? { text: t }
  const warnings: string[] = []

  switch (feature) {
    /* ---------------------------------------------- AI resume screening */
    case 'resume_screening': {
      const candidateId = Number(body.candidateId)
      const jobId = Number(body.jobId)
      if (!candidateId || !jobId) throw new Error('candidateId and jobId are required')

      const cand = await one(db, 'SELECT * FROM candidates WHERE id = ?', candidateId)
      const job = await one(db, 'SELECT * FROM jobs WHERE id = ?', jobId)
      if (!cand) throw new Error('candidate_not_found')
      if (!job) throw new Error('job_not_found')

      const idx = await one(db, 'SELECT * FROM candidate_index WHERE candidate_id = ?', candidateId)
      const resumeText = (idx?.resume_text || cand.summary || '').slice(0, 6000)
      if (!resumeText.trim()) warnings.push('No resume text on file; screening used profile fields only.')

      messages = [
        { role: 'system', content: ADVISORY_SYSTEM },
        {
          role: 'user',
          content: `Screen this candidate against the requisition.

REQUISITION
${jobBlock(job)}

CANDIDATE
${candidateBlock(cand)}

RESUME TEXT (may be truncated)
${resumeText || '(none)'}

Return JSON only:
{
  "fit_score": 0-100,
  "matching_skills": [{"skill":"", "evidence":"quote or fact from the resume"}],
  "missing_skills": [{"skill":"", "why_it_matters":""}],
  "transferable_skills": [{"from":"", "to":""}],
  "strengths": ["..."],
  "gaps": ["..."],
  "confidence": "high|medium|low",
  "explanation": "2-4 sentences citing the evidence above",
  "missing_information": ["what you could not determine"]
}`
        }
      ]
      postProcess = (text) => {
        const j = parseJsonLoose<any>(text) ?? {}
        return {
          ...j,
          // Clamp: the model may drift outside 0-100.
          fit_score: typeof j.fit_score === 'number' ? Math.max(0, Math.min(100, Math.round(j.fit_score))) : null,
          decision_authority: 'none — advisory score only'
        }
      }
      break
    }

    /* ------------------------------------------------ AI resume parsing */
    case 'resume_parsing': {
      let text = String(body.text || '')
      if (!text && body.resumeId) {
        const r = await one(db, 'SELECT * FROM resumes WHERE id = ?', Number(body.resumeId))
        if (!r) throw new Error('resume_not_found')
        text = r.raw_text || ''
      }
      if (!text.trim()) throw new Error('resume_text_required')

      messages = [
        { role: 'system', content: ADVISORY_SYSTEM + '\nYou are extracting structured data from a resume. Copy values verbatim; do not normalise or embellish.' },
        {
          role: 'user',
          content: `Extract structured data from this resume. Use null where a field is absent.

RESUME
${text.slice(0, 12000)}

Return JSON only:
{
  "first_name": "", "last_name": "", "email": null, "phone": null, "location": null,
  "headline": null, "summary": null,
  "employment": [{"employer":"", "title":"", "start":"YYYY-MM", "end":"YYYY-MM or present", "highlights":[""]}],
  "skills": [""], "education": [{"institution":"", "qualification":"", "year":null}],
  "certifications": [""], "total_experience_years": null,
  "confidence": "high|medium|low", "unparsed_sections": [""]
}`
        }
      ]
      postProcess = (t) => parseJsonLoose(t) ?? { text: t }
      break
    }

    /* --------------------------------------- AI job description generator */
    case 'job_description': {
      const title = String(body.title || '').trim()
      if (!title) throw new Error('title is required')
      const must = Array.isArray(body.mustHave) ? body.mustHave.join(', ') : String(body.mustHave || '')
      const nice = Array.isArray(body.niceToHave) ? body.niceToHave.join(', ') : String(body.niceToHave || '')

      messages = [
        { role: 'system', content: ADVISORY_SYSTEM + '\nYou write inclusive, jargon-free job descriptions. Avoid gendered or exclusionary language and avoid inflated requirements.' },
        {
          role: 'user',
          content: `Draft a job description.

Title: ${title}
Department: ${body.department || '—'}
Location: ${body.location || '—'}
Work mode: ${body.workMode || '—'}
Seniority: ${body.seniority || '—'}
Must-have skills: ${must || '—'}
Nice-to-have: ${nice || '—'}
Notes: ${body.notes || '—'}

Return JSON only:
{
  "summary": "", "responsibilities": [""], "required_qualifications": [""],
  "preferred_qualifications": [""], "suggested_skills": [""],
  "inclusive_language_notes": [""], "description_markdown": ""
}`
        }
      ]
      postProcess = (t) => parseJsonLoose(t) ?? { text: t }
      break
    }

    /* --------------------------------------------- AI candidate matching */
    case 'candidate_matching': {
      const jobId = Number(body.jobId)
      if (!jobId) throw new Error('jobId is required')
      const job = await one(db, 'SELECT * FROM jobs WHERE id = ?', jobId)
      if (!job) throw new Error('job_not_found')

      const ids: number[] = Array.isArray(body.candidateIds)
        ? body.candidateIds.map(Number).filter(Boolean).slice(0, 15)
        : []
      let cands: any[]
      if (ids.length) {
        cands = await all(
          db,
          `SELECT c.*, i.skills, i.titles, i.employers
             FROM candidates c LEFT JOIN candidate_index i ON i.candidate_id = c.id
            WHERE c.id IN (${ids.map(() => '?').join(',')}) AND c.status = 'active'`,
          ...ids
        )
      } else {
        // No explicit list: use the applicants already on this requisition.
        cands = await all(
          db,
          `SELECT c.*, i.skills, i.titles, i.employers
             FROM applications a JOIN candidates c ON c.id = a.candidate_id
             LEFT JOIN candidate_index i ON i.candidate_id = c.id
            WHERE a.job_id = ? AND c.status = 'active' LIMIT 15`,
          jobId
        )
      }
      if (!cands.length) throw new Error('no_candidates_in_scope')

      const list = cands.map((c, n) => `--- Candidate ${n + 1} (id ${c.id}) ---
${candidateBlock(c)}
Indexed skills: ${c.skills || '—'}`).join('\n\n')

      messages = [
        { role: 'system', content: ADVISORY_SYSTEM + '\nYou rank candidates only against the stated criteria. You never recommend rejecting anyone.' },
        {
          role: 'user',
          content: `Compare these candidates for the requisition below.

REQUISITION
${jobBlock(job)}

CANDIDATES
${list}

Return JSON only:
{
  "ranking": [{"candidate_id": 0, "fit_score": 0-100, "reasons": [""], "gaps": [""]}],
  "transferable_skills": [{"candidate_id": 0, "skill": "", "maps_to": ""}],
  "notes": "2-3 sentences on what differentiates the shortlist",
  "missing_information": [""]
}`
        }
      ]
      postProcess = (t) => {
        const j = parseJsonLoose<any>(t) ?? {}
        const order = cands.map((c) => c.id)
        return {
          ...j,
          ranking: (j.ranking || []).filter((r: any) => order.includes(Number(r.candidate_id))),
          decision_authority: 'none — ranking is advisory'
        }
      }
      break
    }

    /* ------------------------------------------- AI interview assistant */
    case 'interview_questions': {
      const job = body.jobId ? await one(db, 'SELECT * FROM jobs WHERE id = ?', Number(body.jobId)) : null
      const focus = String(body.focus || 'mixed')
      messages = [
        { role: 'system', content: ADVISORY_SYSTEM + '\nYou design structured, job-relevant interview questions. Avoid questions about protected characteristics, family status, age, or health.' },
        {
          role: 'user',
          content: `Generate an interview kit.

${job ? jobBlock(job) : `Role: ${body.role || 'unspecified'}`}
Focus: ${focus}
Seniority: ${body.seniority || job?.seniority || '—'}

Return JSON only:
{
  "technical": [{"question":"", "looks_for":"", "follow_ups":[""]}],
  "behavioural": [{"question":"", "looks_for":"", "follow_ups":[""]}],
  "role_specific_assessment": {"title":"", "duration_minutes":0, "steps":[""]},
  "red_flags_to_probe": [""]
}`
        }
      ]
      postProcess = (t) => parseJsonLoose(t) ?? { text: t }
      break
    }

    /* ---------------------------------- AI email & communication assistant */
    case 'email_assistant': {
      const kind = String(body.kind || 'follow_up')
      const cand = body.candidateId
        ? await one(db, 'SELECT * FROM candidates WHERE id = ?', Number(body.candidateId))
        : null
      const job = body.jobId ? await one(db, 'SELECT * FROM jobs WHERE id = ?', Number(body.jobId)) : null

      // Consent gate: never draft outreach to a candidate who opted out.
      if (cand && cand.consent_status === 'opt_out') {
        throw Object.assign(
          new Error('This candidate has opted out of communications. Outreach cannot be drafted.'),
          { code: 'consent_opt_out' }
        )
      }

      messages = [
        { role: 'system', content: ADVISORY_SYSTEM + '\nYou draft professional recruiting email. Keep it short, warm, and specific. Never promise outcomes not stated in the input.' },
        {
          role: 'user',
          content: `Draft a ${kind.replace(/_/g, ' ')} email.
${cand ? `\nCandidate first name: ${cand.first_name}` : ''}
${job ? `\nRequisition: ${job.title} (${job.location})` : ''}
Tone: ${body.tone || 'professional and warm'}
${body.draft ? `\nRewrite this draft, preserving its meaning:\n${String(body.draft).slice(0, 3000)}` : ''}
${body.notes ? `\nContext: ${body.notes}` : ''}

Return JSON only:
{ "subject": "", "body": "", "tone_notes": "", "placeholders": [""] }`
        }
      ]
      postProcess = (t) => parseJsonLoose(t) ?? { text: t }
      break
    }

    /* ------------------------------------- AI recruitment analytics narrative */
    case 'analytics_insight': {
      const analytics = await loadAnalytics(db, {
        jobId: body.jobId ? Number(body.jobId) : undefined,
        from: body.from, to: body.to
      } as any)
      // Deterministic insights first — these are the auditable inputs.
      const deterministic = sourceInsights(analytics)

      messages = [
        { role: 'system', content: ADVISORY_SYSTEM + '\nYou summarise recruiting metrics. Cite the numbers you were given. Never extrapolate trends that the data does not show.' },
        {
          role: 'user',
          content: `Write a narrative summary of this recruiting performance data.

METRICS
${JSON.stringify(analytics.metrics, null, 2)}

DENOMINATORS
${JSON.stringify(analytics.denominators, null, 2)}

FUNNEL
${JSON.stringify(analytics.funnel, null, 2)}

BY SOURCE
${JSON.stringify(analytics.bySource, null, 2)}

DROP-OFF REASONS
${JSON.stringify(analytics.dropOffReasons, null, 2)}

PRE-COMPUTED SIGNALS (authoritative — do not contradict)
${JSON.stringify(deterministic, null, 2)}

Return JSON only:
{ "headline": "", "narrative": "", "bottlenecks": [{"stage":"", "evidence":""}], "recommended_checks": [""] }`
        }
      ]
      postProcess = (t) => ({
        ...(parseJsonLoose<any>(t) ?? { narrative: t }),
        // Ship the auditable inputs alongside the prose.
        inputs: { metrics: analytics.metrics, denominators: analytics.denominators, signals: deterministic }
      })
      break
    }

    /* ------------------------------------------------ AI chat assistant */
    case 'chat_assistant': {
      const question = String(body.message || '').trim()
      if (!question) throw new Error('message is required')

      // Role-scoped context. This is the whole data surface the model sees.
      const isManager = user.role === 'hiring_manager'
      const jobFilter = isManager ? 'WHERE hiring_manager_id = ?' : ''
      const jobArgs = isManager ? [user.id] : []

      const openJobs = await all(
        db,
        `SELECT j.id, j.title, j.department, j.status, j.openings,
                (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status='active') AS active_apps
           FROM jobs j ${jobFilter} ${jobFilter ? 'AND' : 'WHERE'} j.status IN ('open','paused','approved')
          ORDER BY j.id DESC LIMIT 20`,
        ...jobArgs
      )
      const pipeline = await all(
        db,
        `SELECT a.stage, COUNT(*) AS n
           FROM applications a JOIN jobs j ON j.id = a.job_id
          ${isManager ? 'WHERE j.hiring_manager_id = ?' : ''}
          GROUP BY a.stage ORDER BY a.stage`,
        ...jobArgs
      )
      const upcoming = await all(
        db,
        `SELECT i.scheduled_at, i.title, c.first_name, c.last_name
           FROM interviews i
           JOIN applications a ON a.id = i.application_id
           JOIN candidates c ON c.id = a.candidate_id
           JOIN jobs j ON j.id = a.job_id
          WHERE i.status IN ('scheduled','confirmed')
          ${isManager ? 'AND j.hiring_manager_id = ?' : ''}
          ORDER BY i.scheduled_at LIMIT 10`,
        ...jobArgs
      )
      const totals = await one(
        db,
        `SELECT (SELECT COUNT(*) FROM candidates WHERE status='active') AS candidates,
                (SELECT COUNT(*) FROM applications WHERE status='active') AS active_applications,
                (SELECT COUNT(*) FROM offers WHERE status IN ('draft','pending_approval','approved','released')) AS open_offers`
      )

      messages = [
        { role: 'system', content: ADVISORY_SYSTEM + `
You answer questions about this ATS using ONLY the context provided. If the answer is not in the context,
say what is missing and suggest which screen the user should open. Do not speculate.
The user's role is "${user.role}". You must not reveal data outside the context below.` },
        {
          role: 'user',
          content: `CONTEXT

Headline totals: ${JSON.stringify(totals)}

Open requisitions: ${JSON.stringify(openJobs)}

Pipeline by stage: ${JSON.stringify(pipeline)}

Upcoming interviews: ${JSON.stringify(upcoming)}

QUESTION
${question}

Answer in plain prose, 3 short paragraphs maximum. Cite specific numbers from the context.`
        }
      ]
      postProcess = (t) => ({ answer: t.trim() })
      break
    }

    default:
      throw new Error('unknown_feature')
  }

  const res = await invoke(env, {
    feature,
    messages,
    userId: user.id,
    temperature: body.temperature,
    maxTokens: body.maxTokens
  })

  return {
    ok: true,
    ...base,
    advisory: true,
    text: res.text,
    data: postProcess(res.text),
    provider: res.providerSlug,
    model: res.model,
    usage: res.usage,
    attempts: res.attempts,
    fellBack: res.fellBack,
    costUsd: res.costUsd,
    ...(warnings.length ? { warnings } : {})
  }
}

/* ------------------------------------------------------------ listFeatures */
export const listFeatures = async (db: D1Database) => {
  const { results } = await db.prepare(
    `SELECT f.*, p.name AS provider_name, p.slug AS provider_slug,
            fp.name AS fallback_name
       FROM ai_feature_config f
       LEFT JOIN ai_providers p ON p.id = f.provider_id
       LEFT JOIN ai_providers fp ON fp.id = f.fallback_provider_id
      ORDER BY f.feature`
  ).all<any>()
  return (results || []).map((r: any) => ({
    ...r,
    label: FEATURE_LABELS[r.feature as FeatureKey]?.label || r.feature,
    hint: FEATURE_LABELS[r.feature as FeatureKey]?.hint || ''
  }))
}
