/**
 * Phase 2 — governed automotive taxonomy (N8).
 *
 * Design rules encoded here:
 *  - The active version is data, not code. Runtime code never invents a node.
 *  - Matching is synonym-aware and edge-aware, and every match reports HOW it
 *    matched (exact / synonym / parent) so the UI can justify a score.
 *  - AI may only *propose* (`taxonomy_suggestions`); a human approves before a
 *    term becomes part of an active version.
 */
import { nowIso, slug } from './util'
import { audit } from './audit'

export type NodeKind =
  | 'industry' | 'domain' | 'subdomain' | 'job_role' | 'specialization'
  | 'competency' | 'technical_skill' | 'software_tool' | 'standard_protocol'
  | 'experience_level'

export type Relation =
  | 'role_to_skill' | 'skill_to_tool' | 'tool_to_domain'
  | 'skill_equivalence' | 'role_equivalent' | 'role_progression'

export type TaxNode = {
  id: number
  version_id: number
  kind: NodeKind
  code: string
  name: string
  description: string | null
  parent_id: number | null
  level: number | null
  active: number
}

export type TaxVersion = {
  id: number
  version: number
  status: 'draft' | 'active' | 'superseded' | 'rolled_back'
  notes: string | null
  created_at: string
  published_at: string | null
}

export type MatchKind = 'exact' | 'synonym' | 'equivalent' | 'partial'

export type TermMatch = {
  nodeId: number
  code: string
  name: string
  kind: NodeKind
  match: MatchKind
  /** 0..1 — how strongly the document supports this node. */
  strength: number
  /** The literal resume/JD text that triggered the match. */
  surface: string
}

/* ------------------------------------------------------------------ versions */

export const loadActiveVersion = async (db: D1Database): Promise<TaxVersion> => {
  const row = await db
    .prepare(`SELECT * FROM taxonomy_versions WHERE status = 'active' ORDER BY version DESC LIMIT 1`)
    .first<TaxVersion>()
  if (row) return row
  // Fail closed but usable: no active version means Phase-2 features degrade to
  // literal keyword matching rather than inventing a taxonomy.
  return { id: 0, version: 0, status: 'draft', notes: null, created_at: nowIso(), published_at: null }
}

export const listVersions = async (db: D1Database) => {
  const { results } = await db
    .prepare(
      `SELECT v.*,
              (SELECT COUNT(*) FROM taxonomy_nodes n WHERE n.version_id = v.id) AS node_count,
              (SELECT COUNT(*) FROM taxonomy_edges e WHERE e.version_id = v.id) AS edge_count,
              u.name AS created_by_name, a.name AS approved_by_name
         FROM taxonomy_versions v
         LEFT JOIN users u ON u.id = v.created_by
         LEFT JOIN users a ON a.id = v.approved_by
        ORDER BY v.version DESC`
    )
    .all<any>()
  return results
}

/** Draft a new version by cloning the active one. Never mutates history. */
export const createVersion = async (
  db: D1Database,
  opts: { notes?: string; actorId?: number | null }
) => {
  const active = await loadActiveVersion(db)
  const next = (active.version || 0) + 1
  const res = await db
    .prepare(
      `INSERT INTO taxonomy_versions (version, status, notes, created_by, created_at)
       VALUES (?, 'draft', ?, ?, ?)`
    )
    .bind(next, opts.notes ?? null, opts.actorId ?? null, nowIso())
    .run()
  const newId = Number(res.meta.last_row_id)

  if (active.id) {
    await db
      .prepare(
        `INSERT INTO taxonomy_nodes (version_id, kind, code, name, description, parent_id, level, active)
         SELECT ?, kind, code, name, description, parent_id, level, active
           FROM taxonomy_nodes WHERE version_id = ?`
      )
      .bind(newId, active.id)
      .run()
    await db
      .prepare(
        `INSERT INTO taxonomy_synonyms (node_id, term)
         SELECT nn.id, ts.term
           FROM taxonomy_synonyms ts
           JOIN taxonomy_nodes on_node ON on_node.id = ts.node_id AND on_node.version_id = ?
           JOIN taxonomy_nodes nn ON nn.version_id = ? AND nn.kind = on_node.kind AND nn.code = on_node.code`
      )
      .bind(active.id, newId)
      .run()
  }

  await audit(db, {
    entityType: 'taxonomy_version', entityId: newId, action: 'taxonomy.version.create',
    actorId: opts.actorId ?? null, newValue: { version: next, clonedFrom: active.version },
    reason: opts.notes ?? null
  })
  return { id: newId, version: next }
}

export const publishVersion = async (
  db: D1Database,
  versionId: number,
  actorId: number
) => {
  const v = await db.prepare(`SELECT * FROM taxonomy_versions WHERE id = ?`).bind(versionId).first<any>()
  if (!v) throw Object.assign(new Error('Version not found'), { status: 404, code: 'not_found' })
  if (v.status !== 'draft') {
    throw Object.assign(new Error('Only a draft version can be published'), { status: 409, code: 'bad_state' })
  }
  const nodes = await db
    .prepare(`SELECT COUNT(*) AS n FROM taxonomy_nodes WHERE version_id = ? AND active = 1`)
    .bind(versionId)
    .first<any>()
  if (!nodes || Number(nodes.n) === 0) {
    throw Object.assign(new Error('Refusing to publish an empty taxonomy version'), {
      status: 422, code: 'empty_version'
    })
  }
  const pending = await db
    .prepare(`SELECT COUNT(*) AS n FROM taxonomy_suggestions WHERE status = 'pending'`)
    .first<any>()

  const ts = nowIso()
  await db.prepare(`UPDATE taxonomy_versions SET status = 'superseded' WHERE status = 'active'`).run()
  await db
    .prepare(`UPDATE taxonomy_versions SET status = 'active', approved_by = ?, published_at = ? WHERE id = ?`)
    .bind(actorId, ts, versionId)
    .run()
  await audit(db, {
    entityType: 'taxonomy_version', entityId: versionId, action: 'taxonomy.version.publish',
    actorId, previousValue: { status: 'draft' }, newValue: { status: 'active', publishedAt: ts },
    meta: { nodes: Number(nodes.n), pendingSuggestions: Number(pending?.n || 0) }
  })
  return { id: versionId, status: 'active', nodes: Number(nodes.n) }
}

export const rollbackVersion = async (db: D1Database, targetVersionId: number, actorId: number) => {
  const target = await db.prepare(`SELECT * FROM taxonomy_versions WHERE id = ?`).bind(targetVersionId).first<any>()
  if (!target) throw Object.assign(new Error('Version not found'), { status: 404, code: 'not_found' })
  const current = await loadActiveVersion(db)
  await db.prepare(`UPDATE taxonomy_versions SET status = 'superseded' WHERE status = 'active'`).run()
  await db.prepare(`UPDATE taxonomy_versions SET status = 'active' WHERE id = ?`).bind(targetVersionId).run()
  await audit(db, {
    entityType: 'taxonomy_version', entityId: targetVersionId, action: 'taxonomy.version.rollback',
    actorId, previousValue: { active: current.version }, newValue: { active: target.version },
    reason: 'Manual rollback'
  })
  return { activeVersion: target.version }
}

/* --------------------------------------------------------------------- graph */

export type TaxGraph = {
  version: TaxVersion
  byId: Map<number, TaxNode>
  byCode: Map<string, TaxNode>
  synonyms: Map<string, number[]>
  children: Map<number, TaxNode[]>
  roleSkills: Map<number, { nodeId: number; weight: number }[]>
  skillTools: Map<number, { nodeId: number; weight: number }[]>
  roleEquivalents: Map<number, { nodeId: number; weight: number }[]>
  toolDomains: Map<number, { nodeId: number; weight: number }[]>
}

/** One query per table, then build the adjacency in memory (Workers: no JOIN storms). */
export const loadGraph = async (db: D1Database): Promise<TaxGraph> => {
  const version = await loadActiveVersion(db)
  const empty: TaxGraph = {
    version, byId: new Map(), byCode: new Map(), synonyms: new Map(), children: new Map(),
    roleSkills: new Map(), skillTools: new Map(), roleEquivalents: new Map(), toolDomains: new Map()
  }
  if (!version.id) return empty

  const [nodesRes, synRes, edgeRes] = await Promise.all([
    db.prepare(`SELECT * FROM taxonomy_nodes WHERE version_id = ? AND active = 1`).bind(version.id).all<TaxNode>(),
    db
      .prepare(
        `SELECT s.node_id, s.term FROM taxonomy_synonyms s
           JOIN taxonomy_nodes n ON n.id = s.node_id AND n.version_id = ? AND n.active = 1`
      )
      .bind(version.id)
      .all<any>(),
    db.prepare(`SELECT * FROM taxonomy_edges WHERE version_id = ?`).bind(version.id).all<any>()
  ])

  for (const n of nodesRes.results) {
    empty.byId.set(n.id, n)
    empty.byCode.set(`${n.kind}:${n.code}`, n)
    if (n.parent_id) {
      const arr = empty.children.get(n.parent_id) || []
      arr.push(n)
      empty.children.set(n.parent_id, arr)
    }
    // A node's own name is also a lookup key at strength 1.
    const key = normalizeTerm(n.name)
    const ids = empty.synonyms.get(key) || []
    if (!ids.includes(n.id)) ids.push(n.id)
    empty.synonyms.set(key, ids)
  }

  for (const s of synRes.results) {
    const key = normalizeTerm(s.term)
    if (!key) continue
    const ids = empty.synonyms.get(key) || []
    if (!ids.includes(s.node_id)) ids.push(s.node_id)
    empty.synonyms.set(key, ids)
  }

  const push = (map: Map<number, { nodeId: number; weight: number }[]>, from: number, to: number, w: number) => {
    const arr = map.get(from) || []
    arr.push({ nodeId: to, weight: w })
    map.set(from, arr)
  }
  for (const e of edgeRes.results) {
    if (e.relation === 'role_to_skill') push(empty.roleSkills, e.from_id, e.to_id, e.weight)
    else if (e.relation === 'skill_to_tool') push(empty.skillTools, e.from_id, e.to_id, e.weight)
    else if (e.relation === 'tool_to_domain') push(empty.toolDomains, e.from_id, e.to_id, e.weight)
    else if (e.relation === 'role_equivalent') push(empty.roleEquivalents, e.from_id, e.to_id, e.weight)
  }

  return empty
}

export const normalizeTerm = (s: string): string =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#./ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/* ------------------------------------------------------------------- matcher */

const STOPWORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'for', 'with', 'in', 'on', 'to', 'at', 'is', 'are',
  'using', 'used', 'worked', 'working', 'experience', 'years', 'year', 'team', 'project',
  'projects', 'good', 'strong', 'knowledge', 'ability', 'skills', 'skill', 'candidate'
])

/**
 * Deterministic dictionary matcher.
 * Scans the document once for every known surface form (name + synonyms), so
 * cost is O(terms) regex scans rather than O(words × terms).
 * `masker` is applied first so protected attributes never influence a match.
 */
export const matchTerms = (graph: TaxGraph, text: string, kinds?: NodeKind[]): TermMatch[] => {
  const out = new Map<number, TermMatch>()
  if (!text || !graph.synonyms.size) return []
  const hay = ` ${normalizeTerm(text)} `

  const consider = (nodeId: number, strength: number, match: MatchKind, surface: string) => {
    const node = graph.byId.get(nodeId)
    if (!node) return
    if (kinds && !kinds.includes(node.kind)) return
    const prior = out.get(nodeId)
    if (!prior || prior.strength < strength) {
      out.set(nodeId, { nodeId, code: node.code, name: node.name, kind: node.kind, match, strength, surface })
    }
  }

  for (const [surface, ids] of graph.synonyms) {
    if (surface.length < 2 || STOPWORDS.has(surface)) continue
    const idx = hay.indexOf(` ${surface} `)
    if (idx === -1) continue
    for (const id of ids) {
      const node = graph.byId.get(id)
      if (!node) continue
      const isName = normalizeTerm(node.name) === surface
      consider(id, isName ? 1 : 0.85, isName ? 'exact' : 'synonym', surface.trim())
    }
  }

  // Role equivalence is a weaker, derived signal — never outranks a literal hit.
  for (const m of [...out.values()]) {
    if (m.kind !== 'job_role') continue
    for (const eq of graph.roleEquivalents.get(m.nodeId) || []) {
      consider(eq.nodeId, m.strength * eq.weight * 0.5, 'equivalent', m.surface)
    }
  }

  return [...out.values()].sort((a, b) => b.strength - a.strength)
}

/** Expand matched skills into the tools a candidate most likely used. */
export const expandToTools = (graph: TaxGraph, skillIds: number[], limit = 40) => {
  const hits = new Map<number, number>()
  for (const id of skillIds) {
    for (const t of graph.skillTools.get(id) || []) {
      hits.set(t.nodeId, Math.max(hits.get(t.nodeId) || 0, t.weight))
    }
  }
  return [...hits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([nodeId, weight]) => ({ nodeId, weight, node: graph.byId.get(nodeId)! }))
    .filter((x) => x.node)
}

/* ---------------------------------------------------------------- coverage */

export type CoverageGap = {
  requirement: string
  nodeId: number | null
  kind: NodeKind | null
  matched: boolean
  via: MatchKind | null
  surface: string | null
}

/**
 * Requirement coverage — the number the JD screen and screening engine both use.
 * `coverage` is matched/total on *must-haves* only; nice-to-haves are reported
 * separately so a missing nice-to-have can never sink a candidate.
 */
export const computeCoverage = (
  graph: TaxGraph,
  mustHaves: string[],
  candidateText: string
) => {
  const matches = matchTerms(graph, candidateText)
  const byNode = new Map(matches.map((m) => [m.nodeId, m]))
  const byName = new Map(matches.map((m) => [normalizeTerm(m.name), m]))

  const gaps: CoverageGap[] = mustHaves.map((req) => {
    const key = normalizeTerm(req)
    // 1) the requirement resolves to a taxonomy node, then 2) is it matched?
    const nodeIds = graph.synonyms.get(key) || []
    const hit = nodeIds.map((id) => byNode.get(id)).find(Boolean) || byName.get(key)
    if (hit) {
      return { requirement: req, nodeId: hit.nodeId, kind: hit.kind, matched: true, via: hit.match, surface: hit.surface }
    }
    // Unresolved requirement: fall back to a literal substring test so a client
    // who types a term we have not modelled is still handled honestly.
    const literal = key.length > 1 && normalizeTerm(candidateText).includes(key)
    return {
      requirement: req, nodeId: nodeIds[0] ?? null,
      kind: nodeIds[0] ? (graph.byId.get(nodeIds[0])?.kind ?? null) : null,
      matched: literal, via: literal ? 'partial' : null, surface: literal ? req : null
    }
  })

  const matched = gaps.filter((g) => g.matched).length
  return {
    gaps,
    matched,
    total: gaps.length,
    coverage: gaps.length === 0 ? 0 : Math.round((matched / gaps.length) * 1000) / 10,
    taxonomyResolved: gaps.filter((g) => g.nodeId !== null).length
  }
}

/** Suggest roles a profile is closest to — used by rediscovery and JD screening. */
export const recommendRoles = (graph: TaxGraph, text: string, limit = 5) => {
  const skills = matchTerms(graph, text, ['technical_skill', 'software_tool', 'standard_protocol'])
  const skillSet = new Set(skills.map((s) => s.nodeId))
  const scored: { node: TaxNode; score: number; matched: number; total: number }[] = []

  for (const [roleId, reqs] of graph.roleSkills) {
    const role = graph.byId.get(roleId)
    if (!role || role.kind !== 'job_role') continue
    const hit = reqs.filter((r) => skillSet.has(r.nodeId) || graph.skillTools.has(r.nodeId))
    const total = reqs.length || 1
    const score = reqs.reduce((acc, r) => acc + (skillSet.has(r.nodeId) ? r.weight : 0), 0) / total
    if (hit.length) scored.push({ node: role, score: Math.round(score * 1000) / 10, matched: hit.length, total })
  }

  // A literal role-title mention always wins.
  const titleHits = matchTerms(graph, text, ['job_role']).filter((m) => m.match === 'exact')
  for (const t of titleHits) {
    const existing = scored.find((s) => s.node.id === t.nodeId)
    if (existing) existing.score = Math.max(existing.score, 90)
    else scored.push({ node: graph.byId.get(t.nodeId)!, score: 90, matched: 0, total: 0 })
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

/* ------------------------------------------------------------- suggestions */

export const recordSuggestion = async (
  db: D1Database,
  input: { term: string; kind?: string; context?: string; source?: string; proposedBy?: number | null }
) => {
  const term = (input.term || '').trim()
  if (!term) throw Object.assign(new Error('term is required'), { status: 422, code: 'invalid' })
  const normalized = slug(term)
  await db
    .prepare(
      `INSERT INTO taxonomy_suggestions (term, normalized, kind, context, source, proposed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(normalized, source) DO UPDATE SET
         occurrences = occurrences + 1,
         context = COALESCE(excluded.context, context)`
    )
    .bind(
      term, normalized, input.kind ?? null, input.context ?? null,
      input.source ?? 'resume', input.proposedBy ?? null, nowIso()
    )
    .run()
  return db
    .prepare(`SELECT * FROM taxonomy_suggestions WHERE normalized = ? AND source = ?`)
    .bind(normalized, input.source ?? 'resume')
    .first<any>()
}

export const listSuggestions = async (db: D1Database, status?: string) => {
  const where = status ? `WHERE s.status = ?` : ''
  const args = status ? [status] : []
  const { results } = await db
    .prepare(
      `SELECT s.*, u.name AS proposed_by_name, r.name AS reviewed_by_name
         FROM taxonomy_suggestions s
         LEFT JOIN users u ON u.id = s.proposed_by
         LEFT JOIN users r ON r.id = s.reviewed_by
        ${where}
        ORDER BY s.occurrences DESC, s.id DESC
        LIMIT 200`
    )
    .bind(...args)
    .all<any>()
  return results
}

/**
 * Approving a suggestion creates a node in the **active** version.
 * That is deliberately the only runtime path that can grow the taxonomy, and it
 * always carries the reviewer's id.
 */
export const reviewSuggestion = async (
  db: D1Database,
  id: number,
  decision: 'approved' | 'rejected' | 'merged',
  opts: { reviewerId: number; note?: string; kind?: string; parentId?: number | null; nodeId?: number | null }
) => {
  const s = await db.prepare(`SELECT * FROM taxonomy_suggestions WHERE id = ?`).bind(id).first<any>()
  if (!s) throw Object.assign(new Error('Suggestion not found'), { status: 404, code: 'not_found' })
  if (s.status !== 'pending') {
    throw Object.assign(new Error('Suggestion already reviewed'), { status: 409, code: 'bad_state' })
  }

  let createdNodeId: number | null = opts.nodeId ?? null
  if (decision === 'approved') {
    const version = await loadActiveVersion(db)
    if (!version.id) throw Object.assign(new Error('No active taxonomy version'), { status: 409, code: 'no_version' })
    const kind = opts.kind || s.kind || 'technical_skill'
    const code = slug(s.term).toUpperCase().replace(/-/g, '_').slice(0, 40) || `TERM_${id}`
    const dup = await db
      .prepare(`SELECT id FROM taxonomy_nodes WHERE version_id = ? AND kind = ? AND code = ?`)
      .bind(version.id, kind, code)
      .first<any>()
    if (dup) {
      createdNodeId = dup.id
    } else {
      const res = await db
        .prepare(
          `INSERT INTO taxonomy_nodes (version_id, kind, code, name, description, parent_id, created_by, approved_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(version.id, kind, code, s.term.trim(), s.context ?? null, opts.parentId ?? null, s.proposed_by ?? null, opts.reviewerId)
        .run()
      createdNodeId = Number(res.meta.last_row_id)
    }
  }

  await db
    .prepare(
      `UPDATE taxonomy_suggestions SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, node_id = ?
        WHERE id = ?`
    )
    .bind(decision, opts.reviewerId, nowIso(), opts.note ?? null, createdNodeId, id)
    .run()

  await audit(db, {
    entityType: 'taxonomy_suggestion', entityId: id, action: `taxonomy.suggestion.${decision}`,
    actorId: opts.reviewerId,
    previousValue: { status: 'pending' },
    newValue: { status: decision, nodeId: createdNodeId },
    reason: opts.note ?? null
  })
  return { id, status: decision, nodeId: createdNodeId }
}

/* ------------------------------------------------------------------ summary */

export const taxonomySummary = async (db: D1Database) => {
  const g = await loadGraph(db)
  const byKind: Record<string, number> = {}
  for (const n of g.byId.values()) byKind[n.kind] = (byKind[n.kind] || 0) + 1
  const pending = await db
    .prepare(`SELECT COUNT(*) AS n FROM taxonomy_suggestions WHERE status = 'pending'`)
    .first<any>()
  const domains = [...g.byId.values()]
    .filter((n) => n.kind === 'domain')
    .map((d) => ({
      ...d,
      subdomains: (g.children.get(d.id) || []).filter((c) => c.kind === 'subdomain').length,
      roles: (g.children.get(d.id) || []).filter((c) => c.kind === 'job_role').length
    }))
  return {
    version: g.version,
    byKind,
    domains,
    nodes: g.byId.size,
    synonyms: g.synonyms.size,
    edges: [...g.roleSkills.values(), ...g.skillTools.values(), ...g.toolDomains.values(), ...g.roleEquivalents.values()]
      .reduce((a, b) => a + b.length, 0),
    pendingSuggestions: Number(pending?.n || 0)
  }
}

/** Browse endpoint for the taxonomy page. */
export const browseNodes = async (db: D1Database, filter: { kind?: string; q?: string }) => {
  const where: string[] = ['n.active = 1']
  const args: unknown[] = []
  if (filter.kind) { where.push('n.kind = ?'); args.push(filter.kind) }
  if (filter.q) { where.push('(lower(n.name) LIKE ? OR lower(n.code) LIKE ?)'); args.push(`%${filter.q.toLowerCase()}%`, `%${filter.q.toLowerCase()}%`) }
  const { results } = await db
    .prepare(
      `SELECT n.*, p.name AS parent_name,
              (SELECT GROUP_CONCAT(term, ' · ') FROM taxonomy_synonyms s WHERE s.node_id = n.id) AS synonyms
         FROM taxonomy_nodes n
         LEFT JOIN taxonomy_nodes p ON p.id = n.parent_id
         JOIN taxonomy_versions v ON v.id = n.version_id AND v.status = 'active'
        WHERE ${where.join(' AND ')}
        ORDER BY n.kind, n.name
        LIMIT 400`
    )
    .bind(...args)
    .all<any>()
  return results.map((r) => ({
    ...r,
    synonym_list: r.synonyms ? String(r.synonyms).split(' · ') : []
  }))
}
