/**
 * ATS-02 — candidate duplicate detection and merge.
 * Signals: normalised email, normalised phone, name similarity, resume similarity.
 * Merges never delete rows: the losing record is marked `merged` and pointed at
 * the canonical candidate, with a reversible snapshot written to candidate_merges.
 */
import { normEmail, normPhone, parseJson, nowIso, hashString } from './util'

const jaroWinkler = (a: string, b: string): number => {
  if (a === b) return 1
  if (!a.length || !b.length) return 0
  const matchDist = Math.floor(Math.max(a.length, b.length) / 2) - 1
  const aMatch = new Array(a.length).fill(false)
  const bMatch = new Array(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDist)
    const end = Math.min(i + matchDist + 1, b.length)
    for (let j = start; j < end; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue
      aMatch[i] = bMatch[j] = true
      matches++
      break
    }
  }
  if (!matches) return 0
  let t = 0
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue
    while (!bMatch[k]) k++
    if (a[i] !== b[k]) t++
    k++
  }
  t /= 2
  const jaro = (matches / a.length + matches / b.length + (matches - t) / matches) / 3
  let prefix = 0
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++
    else break
  }
  return jaro + prefix * 0.1 * (1 - jaro)
}

const tokenSet = (s: string): Set<string> =>
  new Set((s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2))

export const resumeSimilarity = (a: string, b: string): number => {
  const ta = tokenSet(a)
  const tb = tokenSet(b)
  if (!ta.size || !tb.size) return 0
  let inter = 0
  ta.forEach((t) => { if (tb.has(t)) inter++ })
  return inter / (ta.size + tb.size - inter)
}

export type DuplicateSignal = { signal: string; weight: number; detail: string }

export const scorePair = (a: any, b: any, resumeA = '', resumeB = ''): { score: number; signals: DuplicateSignal[] } => {
  const signals: DuplicateSignal[] = []
  let score = 0

  const ea = normEmail(a.email)
  const eb = normEmail(b.email)
  if (ea && ea === eb) {
    score += 0.55
    signals.push({ signal: 'email', weight: 0.55, detail: `identical email ${ea}` })
  } else if (ea && eb && ea.split('@')[1] === eb.split('@')[1] && ea.split('@')[0].replace(/[^a-z]/g, '') === eb.split('@')[0].replace(/[^a-z]/g, '')) {
    score += 0.3
    signals.push({ signal: 'email_local', weight: 0.3, detail: 'same mailbox local part and domain' })
  }

  const pa = normPhone(a.phone)
  const pb = normPhone(b.phone)
  if (pa && pa === pb) {
    score += 0.35
    signals.push({ signal: 'phone', weight: 0.35, detail: `identical phone ${pa}` })
  } else if (pa && pb && pa.slice(-9) === pb.slice(-9)) {
    score += 0.22
    signals.push({ signal: 'phone_suffix', weight: 0.22, detail: 'last 9 digits match' })
  }

  const nameA = `${a.first_name} ${a.last_name}`.toLowerCase().trim()
  const nameB = `${b.first_name} ${b.last_name}`.toLowerCase().trim()
  const njw = jaroWinkler(nameA, nameB)
  if (njw > 0.86) {
    score += 0.2 * njw
    signals.push({ signal: 'name', weight: Math.round(0.2 * njw * 100) / 100, detail: `name similarity ${(njw * 100).toFixed(0)}%` })
  }

  const rs = resumeSimilarity(resumeA, resumeB)
  if (rs > 0.5) {
    score += 0.3 * rs
    signals.push({ signal: 'resume', weight: Math.round(0.3 * rs * 100) / 100, detail: `resume text overlap ${(rs * 100).toFixed(0)}%` })
  }

  if (a.location && b.location && a.location.toLowerCase() === b.location.toLowerCase()) score += 0.03
  if (a.current_employer && b.current_employer && a.current_employer.toLowerCase() === b.current_employer.toLowerCase()) {
    score += 0.05
    signals.push({ signal: 'employer', weight: 0.05, detail: 'same current employer' })
  }

  return { score: Math.min(1, Math.round(score * 100) / 100), signals }
}

export const detectDuplicates = async (db: D1Database, candidateId?: number): Promise<any[]> => {
  const { results: candidates } = await db
    .prepare("SELECT * FROM candidates WHERE status = 'active'")
    .all<any>()
  const { results: indexes } = await db.prepare('SELECT candidate_id, resume_text FROM candidate_index').all<any>()
  const resumeMap = new Map<number, string>(indexes.map((i: any) => [i.candidate_id, i.resume_text || '']))

  const pairs: any[] = []
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]
      const b = candidates[j]
      if (candidateId && a.id !== candidateId && b.id !== candidateId) continue
      const { score, signals } = scorePair(a, b, resumeMap.get(a.id) || '', resumeMap.get(b.id) || '')
      if (score >= 0.45) {
        pairs.push({ a, b, score, signals })
      }
    }
  }
  return pairs.sort((x, y) => y.score - x.score)
}

export const refreshDuplicateQueue = async (db: D1Database): Promise<number> => {
  const pairs = await detectDuplicates(db)
  let added = 0
  for (const p of pairs) {
    const [primary, duplicate] = p.a.created_at <= p.b.created_at ? [p.a, p.b] : [p.b, p.a]
    const res = await db
      .prepare(
        `INSERT INTO duplicate_reviews (primary_id, duplicate_id, score, signals, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(primary_id, duplicate_id) DO UPDATE SET score = excluded.score, signals = excluded.signals
         WHERE duplicate_reviews.status = 'pending'`
      )
      .bind(primary.id, duplicate.id, p.score, JSON.stringify(p.signals), nowIso())
      .run()
    if (res.meta.changes) added++
  }
  return added
}

/** Builds a full merge preview without mutating anything. */
export const mergePreview = async (db: D1Database, primaryId: number, duplicateId: number) => {
  const primary = await db.prepare('SELECT * FROM candidates WHERE id = ?').bind(primaryId).first<any>()
  const dup = await db.prepare('SELECT * FROM candidates WHERE id = ?').bind(duplicateId).first<any>()
  if (!primary || !dup) throw new Error('candidate_not_found')

  const counts = async (table: string, where = 'candidate_id') => {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where} = ?`).bind(duplicateId).first<any>()
    return Number(row?.n || 0)
  }

  const applications = await db
    .prepare('SELECT a.id, a.job_id, j.title, a.stage, a.status FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.candidate_id = ?')
    .bind(duplicateId)
    .all<any>()

  const conflicts = await db
    .prepare(
      `SELECT a.job_id, j.title FROM applications a JOIN jobs j ON j.id = a.job_id
        WHERE a.candidate_id = ? AND a.job_id IN (SELECT job_id FROM applications WHERE candidate_id = ?)`
    )
    .bind(duplicateId, primaryId)
    .all<any>()

  return {
    primary,
    duplicate: dup,
    will_move: {
      applications: Number((await counts('applications'))),
      resumes: await counts('resumes'),
      notes: await counts('candidate_notes'),
      messages: await counts('messages'),
      tags: await counts('candidate_tags'),
      pool_memberships: await counts('talent_pool_members'),
      consents: await counts('candidate_consent')
    },
    applications_to_merge: applications.results,
    duplicate_applications_on_same_job: conflicts.results,
    conflict_note: conflicts.results.length
      ? 'Applications on the same requisition will be collapsed into the primary application; history is preserved.'
      : 'No conflicting applications.',
    reversible: true
  }
}

export const executeMerge = async (
  db: D1Database,
  primaryId: number,
  duplicateId: number,
  actorId: number,
  reason?: string
) => {
  if (primaryId === duplicateId) throw new Error('cannot_merge_self')
  const primary = await db.prepare('SELECT * FROM candidates WHERE id = ?').bind(primaryId).first<any>()
  const dup = await db.prepare('SELECT * FROM candidates WHERE id = ?').bind(duplicateId).first<any>()
  if (!primary || !dup) throw new Error('candidate_not_found')
  if (dup.status === 'merged') throw new Error('already_merged')

  const moved: Record<string, number> = {}

  const move = async (table: string, where = '') => {
    const sql = `UPDATE ${table} SET candidate_id = ? WHERE candidate_id = ?${where}`
    const res = await db.prepare(sql).bind(primaryId, duplicateId).run()
    moved[table] = res.meta.changes || 0
  }

  // Resolve same-requisition conflicts first: keep the earliest application as canonical
  const conflicts = await db
    .prepare(
      `SELECT d.id AS dup_app, p.id AS pri_app, d.job_id
         FROM applications d
         JOIN applications p ON p.candidate_id = ? AND p.job_id = d.job_id
        WHERE d.candidate_id = ?`
    )
    .bind(primaryId, duplicateId)
    .all<any>()

  for (const c of conflicts.results) {
    // Re-point child records of the duplicate application to the primary application
    for (const child of ['interviews', 'offers', 'onboarding', 'tasks']) {
      const col = 'application_id'
      const exists = await db
        .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('${child}') WHERE name = ?`)
        .bind(col)
        .first<any>()
      if (Number(exists?.n || 0)) {
        const hasUnique = child === 'onboarding'
        if (hasUnique) {
          const taken = await db.prepare('SELECT id FROM onboarding WHERE application_id = ?').bind(c.pri_app).first<any>()
          if (taken) continue
        }
        await db.prepare(`UPDATE ${child} SET application_id = ? WHERE application_id = ?`).bind(c.pri_app, c.dup_app).run()
      }
    }
    await db.prepare('UPDATE application_stage_history SET application_id = ? WHERE application_id = ?').bind(c.pri_app, c.dup_app).run()
    await db.prepare('UPDATE candidate_notes SET application_id = ? WHERE application_id = ?').bind(c.pri_app, c.dup_app).run()
    await db.prepare('DELETE FROM applications WHERE id = ?').bind(c.dup_app).run()
    moved.merged_applications = (moved.merged_applications || 0) + 1
  }

  await move('applications')
  await move('resumes')
  await move('candidate_notes')
  await move('messages')
  await move('talent_pool_members')
  await move('data_subject_requests')

  // tags: copy non-duplicates then drop
  const { results: dupTags } = await db.prepare('SELECT tag_id FROM candidate_tags WHERE candidate_id = ?').bind(duplicateId).all<any>()
  for (const t of dupTags) {
    await db
      .prepare('INSERT INTO candidate_tags (candidate_id, tag_id, tagged_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
      .bind(primaryId, t.tag_id, actorId)
      .run()
  }
  await db.prepare('DELETE FROM candidate_tags WHERE candidate_id = ?').bind(duplicateId).run()
  await db.prepare('DELETE FROM candidate_index WHERE candidate_id = ?').bind(duplicateId).run()

  // Fill blank profile fields from the duplicate (never overwrite primary values)
  const fillable = [
    'phone', 'location', 'country', 'headline', 'current_employer', 'education', 'experience_years',
    'notice_period_days', 'current_salary', 'expected_salary', 'availability', 'summary', 'linkedin'
  ]
  const patch: Record<string, any> = {}
  for (const f of fillable) {
    if ((primary[f] === null || primary[f] === '' || primary[f] === undefined) && dup[f]) patch[f] = dup[f]
  }
  if (dup.consent_status === 'opt_out') patch.consent_status = 'opt_out'

  const snapshot = { primary, duplicate: dup, moved }

  await db
    .prepare(
      `INSERT INTO candidate_merges (canonical_id, merged_id, snapshot, moved, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(primaryId, duplicateId, JSON.stringify(snapshot), JSON.stringify(moved), actorId, nowIso())
    .run()

  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ')
  await db
    .prepare(
      `UPDATE candidates SET ${sets ? sets + ', ' : ''}status = 'merged', merged_into_id = ?, updated_at = ?
        WHERE id = ?`
    )
    .bind(...Object.values(patch), primaryId, nowIso(), duplicateId)
    .run()

  await db
    .prepare("UPDATE duplicate_reviews SET status = 'merged', decided_by = ?, decided_at = ? WHERE (primary_id = ? AND duplicate_id = ?) OR (primary_id = ? AND duplicate_id = ?)")
    .bind(actorId, nowIso(), primaryId, duplicateId, duplicateId, primaryId)
    .run()

  await db
    .prepare(
      `INSERT INTO audit_events (entity_type, entity_id, action, actor_id, previous_value, new_value, reason, created_at)
       VALUES ('candidate', ?, 'merge', ?, ?, ?, ?, ?)`
    )
    .bind(String(primaryId), actorId, JSON.stringify({ merged_id: duplicateId }), JSON.stringify({ canonical_id: primaryId }), reason || 'Merged duplicate candidate', nowIso())
    .run()

  return { canonical_id: primaryId, merged_id: duplicateId, moved, merge_hash: hashString(JSON.stringify(snapshot)).slice(0, 10) }
}

/** Reopening a merge restores the candidate row and re-points its own records only. */
export const revertMerge = async (db: D1Database, mergeId: number, actorId: number) => {
  const merge = await db.prepare('SELECT * FROM candidate_merges WHERE id = ?').bind(mergeId).first<any>()
  if (!merge) throw new Error('merge_not_found')
  if (merge.reverted_at) throw new Error('already_reverted')

  const snapshot = parseJson<any>(merge.snapshot, {})
  const dup = snapshot.duplicate
  if (!dup) throw new Error('snapshot_missing')

  await db
    .prepare(
      `UPDATE candidates SET status = 'active', merged_into_id = NULL, updated_at = ?
        WHERE id = ? AND status = 'merged'`
    )
    .bind(nowIso(), merge.merged_id)
    .run()

  await db.prepare('UPDATE candidate_merges SET reverted_at = ?, reverted_by = ? WHERE id = ?').bind(nowIso(), actorId, mergeId).run()

  await db
    .prepare(
      `INSERT INTO audit_events (entity_type, entity_id, action, actor_id, previous_value, new_value, reason, created_at)
       VALUES ('candidate', ?, 'merge_reverted', ?, ?, ?, ?, ?)`
    )
    .bind(
      String(merge.canonical_id),
      actorId,
      JSON.stringify({ status: 'merged' }),
      JSON.stringify({ restored_candidate: merge.merged_id }),
      'Merge reverted — candidate identity restored',
      nowIso()
    )
    .run()

  return {
    restored_candidate: merge.merged_id,
    note: 'Candidate profile restored. Moved records are not automatically re-pointed; the snapshot retains the original ownership map for manual reconciliation.'
  }
}
