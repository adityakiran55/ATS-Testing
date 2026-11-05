import { hoursBetween, daysBetween, pct, nowIso } from './util'
import { STAGE_ORDER, stageIndex } from './lifecycle'

/**
 * Metric definitions (ATS-09 / ATS-15). Every dashboard label resolves to one of
 * these entries so the UI, exports and API share a single definition.
 */
export type MetricDef = {
  key: string
  label: string
  definition: string
  numerator: string
  denominator: string
  unit: 'count' | 'percent' | 'hours' | 'days'
}

export const METRIC_DEFS: MetricDef[] = [
  {
    key: 'applications',
    label: 'Applications',
    definition: 'Applications created in the filtered period, counted once per candidate-per-requisition.',
    numerator: 'COUNT(applications)',
    denominator: '—',
    unit: 'count'
  },
  {
    key: 'shortlist_rate',
    label: 'Shortlist rate',
    definition: 'Share of applications that reached recruiter review or beyond (recruiter_review → hired).',
    numerator: 'Applications whose max stage index ≥ recruiter_review',
    denominator: 'All applications in scope',
    unit: 'percent'
  },
  {
    key: 'interview_to_offer',
    label: 'Interview → offer ratio',
    definition: 'Offers raised against applications that reached the interview stage.',
    numerator: 'Applications with at least one offer record',
    denominator: 'Applications that reached the interview stage',
    unit: 'percent'
  },
  {
    key: 'offer_acceptance_rate',
    label: 'Offer acceptance rate',
    definition: 'Accepted offers divided by offers that received a candidate decision.',
    numerator: 'Offers with status accepted',
    denominator: 'Offers with status accepted or declined',
    unit: 'percent'
  },
  {
    key: 'time_to_screen',
    label: 'Time to screen',
    definition: 'Median elapsed hours from application created to first entry into the screening stage.',
    numerator: 'stage history (applied → screening) elapsed hours',
    denominator: 'Applications that reached screening',
    unit: 'hours'
  },
  {
    key: 'time_to_interview',
    label: 'Time to interview',
    definition: 'Median elapsed hours from application created to the first interview being scheduled.',
    numerator: 'first interview scheduled_at − applied_at',
    denominator: 'Applications with an interview',
    unit: 'hours'
  },
  {
    key: 'time_to_offer',
    label: 'Time to offer',
    definition: 'Median elapsed hours from application created to the first offer being released.',
    numerator: 'first offer released_at − applied_at',
    denominator: 'Applications with a released offer',
    unit: 'hours'
  },
  {
    key: 'time_to_fill',
    label: 'Time to fill',
    definition: 'Median days from requisition opening to the requisition being marked filled.',
    numerator: 'jobs.filled timestamp − jobs.opened_at',
    denominator: 'Filled requisitions in scope',
    unit: 'days'
  },
  {
    key: 'time_to_hire',
    label: 'Time to hire',
    definition: 'Median days from application created to the application reaching hired.',
    numerator: 'application hired timestamp − applied_at',
    denominator: 'Hired applications in scope',
    unit: 'days'
  },
  {
    key: 'requisition_aging',
    label: 'Requisition aging',
    definition: 'Median days open for requisitions still in open/paused state as of now.',
    numerator: 'now − jobs.opened_at',
    denominator: 'Open or paused requisitions in scope',
    unit: 'days'
  }
]

const median = (nums: number[]): number => {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const round1 = (n: number) => Math.round(n * 10) / 10

export type AnalyticsFilter = {
  from?: string
  to?: string
  jobId?: number
  recruiterId?: number
  location?: string
  source?: string
}

const buildAppWhere = (f: AnalyticsFilter) => {
  const w: string[] = []
  const a: unknown[] = []
  if (f.from) { w.push('a.applied_at >= ?'); a.push(f.from) }
  if (f.to) { w.push('a.applied_at <= ?'); a.push(f.to) }
  if (f.jobId) { w.push('a.job_id = ?'); a.push(f.jobId) }
  if (f.recruiterId) { w.push('a.recruiter_id = ?'); a.push(f.recruiterId) }
  if (f.location) { w.push('j.location = ?'); a.push(f.location) }
  if (f.source) { w.push('a.source = ?'); a.push(f.source) }
  return { clause: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a }
}

export type AnalyticsResult = ReturnType<typeof summarize>

const summarize = (apps: any[], interviews: any[], offers: any[], jobs: any[]) => {
  const total = apps.length
  const reached = (stage: string) =>
    apps.filter((a) => Math.max(stageIndex(a.stage), ...(a.max_stage ? [stageIndex(a.max_stage)] : [])) >= stageIndex(stage))

  const shortlisted = reached('recruiter_review').length
  const interviewed = reached('interview').length
  const offersRaised = apps.filter((a) => a.offer_count > 0).length
  const offersAccepted = offers.filter((o) => o.status === 'accepted').length
  const offersDecided = offers.filter((o) => ['accepted', 'declined'].includes(o.status)).length

  const screenTimes = apps
    .filter((a) => a.screening_at)
    .map((a) => hoursBetween(a.applied_at, a.screening_at))
    .filter((n) => n >= 0)
  const interviewTimes = interviews
    .filter((i) => i.scheduled_at && i.applied_at)
    .map((i) => hoursBetween(i.applied_at, i.scheduled_at))
    .filter((n) => n >= 0)
  const offerTimes = offers
    .filter((o) => o.released_at && o.applied_at)
    .map((o) => hoursBetween(o.applied_at, o.released_at))
    .filter((n) => n >= 0)
  const hireTimes = apps
    .filter((a) => a.hired_at)
    .map((a) => daysBetween(a.applied_at, a.hired_at))
    .filter((n) => n >= 0)
  const fillTimes = jobs
    .filter((j) => j.filled_at && j.opened_at)
    .map((j) => daysBetween(j.opened_at, j.filled_at))
    .filter((n) => n >= 0)
  const aging = jobs
    .filter((j) => ['open', 'paused'].includes(j.status) && j.opened_at)
    .map((j) => daysBetween(j.opened_at, nowIso()))
    .filter((n) => n >= 0)

  const funnel = STAGE_ORDER.map((stage, idx) => {
    const count = apps.filter((a) => {
      const max = Math.max(stageIndex(a.stage), a.max_stage ? stageIndex(a.max_stage) : 0)
      return max >= idx && a.status !== 'withdrawn'
    }).length
    return { stage, count }
  }).map((row, i, arr) => ({
    ...row,
    conversion_from_previous: i === 0 ? 100 : pct(row.count, arr[i - 1].count || 1),
    conversion_from_top: pct(row.count, arr[0].count || 1)
  }))

  return {
    metrics: {
      applications: total,
      shortlist_rate: pct(shortlisted, total),
      interview_to_offer: pct(offersRaised, interviewed || 0),
      offer_acceptance_rate: pct(offersAccepted, offersDecided),
      time_to_screen: round1(median(screenTimes)),
      time_to_interview: round1(median(interviewTimes)),
      time_to_offer: round1(median(offerTimes)),
      time_to_fill: round1(median(fillTimes)),
      time_to_hire: round1(median(hireTimes)),
      requisition_aging: round1(median(aging))
    },
    denominators: {
      applications: total,
      shortlisted,
      interviewed,
      offers_raised: offersRaised,
      offers_decided: offersDecided,
      screening_samples: screenTimes.length,
      interview_samples: interviewTimes.length,
      offer_samples: offerTimes.length,
      hire_samples: hireTimes.length,
      fill_samples: fillTimes.length,
      aging_samples: aging.length
    },
    funnel,
    bySource: groupBy(apps, (a) => a.source || 'unknown').map(([source, rows]) => ({
      source,
      applications: rows.length,
      shortlisted: rows.filter((r) => Math.max(stageIndex(r.stage), r.max_stage ? stageIndex(r.max_stage) : 0) >= stageIndex('recruiter_review')).length,
      interviewed: rows.filter((r) => Math.max(stageIndex(r.stage), r.max_stage ? stageIndex(r.max_stage) : 0) >= stageIndex('interview')).length,
      hired: rows.filter((r) => r.status === 'hired').length,
      rejected: rows.filter((r) => r.status === 'rejected').length,
      withdrawn: rows.filter((r) => r.status === 'withdrawn').length,
      conversion: pct(rows.filter((r) => r.status === 'hired').length, rows.length),
      avg_stage_index: round1(rows.reduce((s, r) => s + stageIndex(r.stage), 0) / (rows.length || 1))
    })),
    dropOffReasons: groupBy(
      apps.filter((a) => a.rejection_reason || a.drop_off_reason),
      (a) => a.rejection_reason || a.drop_off_reason
    ).map(([reason, rows]) => ({ reason, count: rows.length })),
    byRecruiter: groupBy(apps.filter((a) => a.recruiter_id), (a) => String(a.recruiter_id)).map(([id, rows]) => ({
      recruiter_id: Number(id),
      recruiter: rows[0].recruiter_name || `User ${id}`,
      applications: rows.length,
      active: rows.filter((r) => r.status === 'active').length,
      hired: rows.filter((r) => r.status === 'hired').length,
      overdue: rows.filter((r) => r.overdue).length
    })),
    byStage: STAGE_ORDER.map((stage) => ({
      stage,
      count: apps.filter((a) => a.stage === stage && a.status === 'active').length
    }))
  }
}

const groupBy = <T>(arr: T[], key: (t: T) => string): [string, T[]][] => {
  const m = new Map<string, T[]>()
  for (const item of arr) {
    const k = key(item)
    if (!m.has(k)) m.set(k, [])
    m.get(k)!.push(item)
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
}

export const loadAnalytics = async (db: D1Database, f: AnalyticsFilter): Promise<AnalyticsResult> => {
  const where = buildAppWhere(f)

  const { results: apps } = await db
    .prepare(
      `SELECT a.*, j.title AS job_title, j.location, j.department,
              u.name AS recruiter_name,
              (SELECT MIN(h.created_at) FROM application_stage_history h
                WHERE h.application_id = a.id AND h.to_stage = 'screening') AS screening_at,
              (SELECT MAX(h.to_stage) FROM application_stage_history h
                WHERE h.application_id = a.id) AS max_stage_raw,
              (SELECT COUNT(*) FROM offers o WHERE o.application_id = a.id) AS offer_count,
              CASE WHEN a.status = 'hired' THEN a.closed_at END AS hired_at
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         LEFT JOIN users u ON u.id = a.recruiter_id
         ${where.clause}
         ORDER BY a.applied_at DESC`
    )
    .bind(...where.args)
    .all<any>()

  // max_stage: highest stage the application actually reached in history
  const maxIdx = STAGE_ORDER.length - 1
  const normalized = apps.map((a) => {
    let best = a.stage
    if (a.max_stage_raw && stageIndex(a.max_stage_raw) > stageIndex(best)) best = a.max_stage_raw
    return { ...a, max_stage: best, offer_count: Number(a.offer_count || 0) }
  })

  const { results: interviews } = await db
    .prepare(
      `SELECT i.*, a.applied_at, a.job_id FROM interviews i
         JOIN applications a ON a.id = i.application_id
         JOIN jobs j ON j.id = a.job_id
         ${where.clause}`
    )
    .bind(...where.args)
    .all<any>()

  const { results: offers } = await db
    .prepare(
      `SELECT o.*, a.applied_at, a.job_id FROM offers o
         JOIN applications a ON a.id = o.application_id
         JOIN jobs j ON j.id = a.job_id
         ${where.clause}`
    )
    .bind(...where.args)
    .all<any>()

  const { results: jobs } = await db
    .prepare(
      `SELECT j.*, j.filled_at FROM jobs j
        WHERE (? IS NULL OR j.id = ?)`
    )
    .bind(f.jobId ?? null, f.jobId ?? null)
    .all<any>()

  void maxIdx
  return summarize(normalized, interviews, offers, jobs)
}

export const buildFunnelByJob = (apps: any[]) =>
  groupBy(apps, (a) => a.job_title || 'unknown').map(([job, rows]) => ({
    job,
    total: rows.length,
    stages: STAGE_ORDER.map((stage) => ({ stage, count: rows.filter((r) => stageIndex(r.stage) >= stageIndex(stage)).length }))
  }))
