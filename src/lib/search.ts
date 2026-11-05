/**
 * ATS-01 Boolean search + ATS-13 semantic search.
 * Both operate on the denormalised `candidate_index` document so a single
 * query pass can explain *why* each candidate matched.
 */

export type SearchDoc = {
  candidate_id: number
  search_blob: string
  skills: string
  titles: string
  employers: string
  education: string
  locations: string
  resume_text: string
}

export type CandidateRow = {
  id: number
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
  created_at: string
  tags?: string | null
  application_count?: number
  last_application?: string | null
}

type Node =
  | { t: 'term'; v: string; field?: string }
  | { t: 'phrase'; v: string; field?: string }
  | { t: 'and'; l: Node; r: Node }
  | { t: 'or'; l: Node; r: Node }
  | { t: 'not'; c: Node }

const tokenize = (q: string): string[] => {
  const out: string[] = []
  let i = 0
  while (i < q.length) {
    const ch = q[i]
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '(' || ch === ')') { out.push(ch); i++; continue }
    if (ch === '"') {
      let j = i + 1
      while (j < q.length && q[j] !== '"') j++
      out.push('"' + q.slice(i + 1, j) + '"')
      i = j + 1
      continue
    }
    let j = i
    while (j < q.length && !/[\s()"]/.test(q[j])) j++
    out.push(q.slice(i, j))
    i = j
  }
  return out
}

const FIELD_ALIASES: Record<string, keyof SearchDoc> = {
  skill: 'skills', skills: 'skills',
  title: 'titles', titles: 'titles', role: 'titles',
  employer: 'employers', company: 'employers', employers: 'employers',
  education: 'education', school: 'education', degree: 'education',
  location: 'locations', city: 'locations', country: 'locations',
  resume: 'resume_text', text: 'resume_text'
}

/** Recursive-descent parser for AND / OR / NOT / parentheses / "exact phrase". */
export const parseQuery = (input: string): Node => {
  const tokens = tokenize(input)
  let pos = 0

  const peek = () => tokens[pos]
  const eat = () => tokens[pos++]

  const parsePrimary = (): Node => {
    const tok = peek()
    if (!tok) return { t: 'term', v: '' }
    if (tok === '(') {
      eat()
      const node = parseOr()
      if (peek() === ')') eat()
      return node
    }
    if (/^(and|or|not)$/i.test(tok) && tok !== '"') {
      eat()
      return parsePrimary()
    }
    eat()
    let field: string | undefined
    let raw = tok
    const fm = /^([a-z_]+):(.*)$/i.exec(raw)
    if (fm && FIELD_ALIASES[fm[1].toLowerCase()]) {
      field = FIELD_ALIASES[fm[1].toLowerCase()]
      raw = fm[2]
    }
    if (raw.startsWith('"')) return { t: 'phrase', v: raw.replace(/"/g, '').toLowerCase(), field }
    return { t: 'term', v: raw.toLowerCase(), field }
  }

  const parseNot = (): Node => {
    const tok = peek()
    if (tok && /^not$/i.test(tok) && tok !== '"') {
      eat()
      return { t: 'not', c: parseNot() }
    }
    if (tok && tok.startsWith('-') && tok.length > 1) {
      eat()
      return { t: 'not', c: { t: 'term', v: tok.slice(1).toLowerCase() } }
    }
    return parsePrimary()
  }

  const parseAnd = (): Node => {
    let left = parseNot()
    while (true) {
      const tok = peek()
      if (!tok || tok === ')') break
      if (/^or$/i.test(tok) && tok !== '"') break
      if (/^and$/i.test(tok) && tok !== '"') eat()
      const right = parseNot()
      left = { t: 'and', l: left, r: right }
    }
    return left
  }

  const parseOr = (): Node => {
    let left = parseAnd()
    while (peek() && /^or$/i.test(peek()) && peek() !== '"') {
      eat()
      left = { t: 'or', l: left, r: parseAnd() }
    }
    return left
  }

  return parseOr()
}

const fieldText = (doc: SearchDoc, field?: string): string => {
  if (!field) return doc.search_blob || ''
  const v = (doc as any)[field]
  return (v || '').toString()
}

export type BoolMatch = { matched: boolean; reasons: string[] }

const evalNode = (node: Node, doc: SearchDoc, reasons: string[]): boolean => {
  switch (node.t) {
    case 'term': {
      if (!node.v) return true
      const text = fieldText(doc, node.field).toLowerCase()
      const hit = text.includes(node.v)
      if (hit) reasons.push(node.field ? `${node.field}:${node.v}` : node.v)
      return hit
    }
    case 'phrase': {
      const text = fieldText(doc, node.field).toLowerCase()
      const hit = text.includes(node.v)
      if (hit) reasons.push(`"${node.v}"`)
      return hit
    }
    case 'and': return evalNode(node.l, doc, reasons) && evalNode(node.r, doc, reasons)
    case 'or': {
      const l: string[] = []
      const r: string[] = []
      const lm = evalNode(node.l, doc, l)
      const rm = evalNode(node.r, doc, r)
      if (lm || rm) reasons.push(...(lm ? l : []), ...(rm ? r : []))
      return lm || rm
    }
    case 'not': {
      const sub: string[] = []
      const m = evalNode(node.c, doc, sub)
      return !m
    }
    default: return true
  }
}

export const runBoolean = (query: string, doc: SearchDoc): BoolMatch => {
  if (!query.trim()) return { matched: true, reasons: [] }
  const reasons: string[] = []
  let ast: Node
  try { ast = parseQuery(query) } catch { return { matched: false, reasons: ['parse_error'] } }
  const matched = evalNode(ast, doc, reasons)
  return { matched, reasons: [...new Set(reasons)] }
}

/** ------------------------------------------------------------- semantic ---- */

const SYNONYMS: string[][] = [
  ['react', 'reactjs', 'react.js'], ['node', 'nodejs', 'node.js'],
  ['ts', 'typescript'], ['js', 'javascript'], ['ml', 'machine', 'learning'],
  ['ai', 'artificial', 'intelligence'], ['k8s', 'kubernetes'], ['gcp', 'google', 'cloud'],
  ['aws', 'amazon', 'webservices'], ['sr', 'senior'], ['pm', 'product', 'manager'],
  ['ui', 'frontend', 'front-end'], ['ux', 'design', 'designer'],
  ['qa', 'quality', 'assurance', 'testing'], ['sql', 'database', 'rdbms'],
  ['devops', 'sre', 'platform', 'infrastructure'], ['hr', 'people', 'talent'],
  ['go', 'golang'], ['py', 'python']
]

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'at', 'to', 'who', 'that',
  'is', 'are', 'be', 'has', 'have', 'had', 'we', 'our', 'need', 'looking', 'someone', 'able',
  'experience', 'experienced', 'strong', 'good', 'great', 'must', 'should', 'can', 'will'
])

const stem = (w: string): string => {
  let s = w.toLowerCase()
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y'
  else if (s.length > 4 && s.endsWith('ing')) s = s.slice(0, -3)
  else if (s.length > 3 && s.endsWith('ed')) s = s.slice(0, -2)
  else if (s.length > 3 && s.endsWith('s')) s = s.slice(0, -1)
  return s
}

export const expandQuery = (query: string): string[] => {
  const base = query.toLowerCase().replace(/[^a-z0-9+#. ]+/g, ' ').split(/\s+/).filter(Boolean)
  const out = new Set<string>()
  for (const w of base) {
    if (STOP.has(w)) continue
    out.add(stem(w))
    for (const group of SYNONYMS) {
      if (group.some((g) => g === w || stem(g) === stem(w))) group.forEach((g) => out.add(stem(g)))
    }
  }
  return [...out]
}

const vectorize = (terms: string[]): Map<string, number> => {
  const v = new Map<string, number>()
  for (const t of terms) v.set(t, (v.get(t) || 0) + 1)
  let norm = 0
  v.forEach((n) => (norm += n * n))
  norm = Math.sqrt(norm) || 1
  v.forEach((n, k) => v.set(k, n / norm))
  return v
}

const cosine = (a: Map<string, number>, b: Map<string, number>): number => {
  let dot = 0
  a.forEach((n, k) => { const m = b.get(k); if (m) dot += n * m })
  return dot
}

export type SemanticMatch = { score: number; matchedTerms: string[]; matchedField: string }

export const runSemantic = (query: string, doc: SearchDoc): SemanticMatch => {
  const terms = expandQuery(query)
  if (!terms.length) return { score: 0, matchedTerms: [], matchedField: 'none' }

  const fields: [string, string][] = [
    ['skills', doc.skills || ''],
    ['titles', doc.titles || ''],
    ['employers', doc.employers || ''],
    ['education', doc.education || ''],
    ['resume', doc.resume_text || '']
  ]

  const qv = vectorize(terms)
  let best = 0
  let bestField = 'none'
  const matched = new Set<string>()

  for (const [name, text] of fields) {
    const docTerms = (text.toLowerCase().match(/[a-z0-9+#.]+/g) || []).map(stem)
    const dv = vectorize(docTerms)
    const sim = cosine(qv, dv)
    const weight = name === 'skills' ? 1.25 : name === 'titles' ? 1.1 : 1
    const weighted = sim * weight
    if (weighted > best) { best = weighted; bestField = name }
    for (const t of terms) if (docTerms.includes(t)) matched.add(t)
  }

  const coverage = terms.length ? matched.size / terms.length : 0
  const score = Math.min(1, best * 0.55 + coverage * 0.45)
  return { score: Math.round(score * 1000) / 1000, matchedTerms: [...matched], matchedField: bestField }
}

export const synonymHint = (term: string): string[] => {
  const s = stem(term)
  const g = SYNONYMS.find((group) => group.some((x) => stem(x) === s))
  return g ? g.filter((x) => stem(x) !== s) : []
}

/** ------------------------------------------------------------- filters ---- */
export type SearchFilters = {
  q?: string
  mode?: 'boolean' | 'semantic'
  skills?: string[]
  titles?: string[]
  employers?: string[]
  locations?: string[]
  education?: string
  minExperience?: number
  maxExperience?: number
  maxNotice?: number
  maxSalary?: number
  tags?: string[]
  consent?: string
  poolId?: number
  appliedToJobId?: number
  hasApplications?: boolean
  status?: string
  sort?: string
  page?: number
  perPage?: number
}

export const SORT_OPTIONS: Record<string, string> = {
  relevance: 'Relevance',
  recent: 'Most recently added',
  experience: 'Most experience',
  name: 'Name (A–Z)',
  applications: 'Most applications',
  salary: 'Lowest salary expectation'
}
