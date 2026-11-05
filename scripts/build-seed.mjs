import { writeFileSync } from 'node:fs'

/* Deterministic PRNG so the seed is reproducible run to run. */
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const rnd = mulberry32(20261105)
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
const int = (min, max) => Math.floor(rnd() * (max - min + 1)) + min
const chance = (p) => rnd() < p
const iso = (daysAgo, hour = 10) => {
  const d = new Date(Date.UTC(2026, 10, 5, hour, 0, 0) - daysAgo * 86400000)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
const q = (v) => (v === null || v === undefined || v === 'NULL' ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
/** Date-safe quoting: null / 'NULL' → NULL, otherwise a quoted ISO string. */
const qd = (v) => (v === null || v === undefined || v === 'NULL' ? 'NULL' : q(v))

/* ------------------------------------------------------------------ password */
const enc = new TextEncoder()
const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const hashPassword = async (pw) => {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 60000, hash: 'SHA-256' }, key, 256)
  return `pbkdf2$60000$${toHex(salt.buffer)}$${toHex(bits)}`
}

const lines = []
const w = (s) => lines.push(s)

const FIRST = ['Aarav', 'Priya', 'Marcus', 'Elena', 'Tobias', 'Sofia', 'Daniel', 'Amara', 'Nguyen', 'Leila',
  'Rafael', 'Ingrid', 'Kwame', 'Yuki', 'Hassan', 'Nadia', 'Oliver', 'Mei', 'Diego', 'Fatima',
  'Lucas', 'Zara', 'Andres', 'Hana', 'Viktor', 'Chloe', 'Rohan', 'Isabel', 'Tariq', 'Anya',
  'Samuel', 'Beatriz', 'Kai', 'Aisha', 'Noah', 'Camila', 'Ethan', 'Sana', 'Felix', 'Maya',
  'Jonas', 'Divya', 'Marco', 'Yara', 'Adam', 'Nora', 'Pablo', 'Rin', 'Idris', 'Clara']
const LAST = ['Sharma', 'Okafor', 'Lindqvist', 'Rossi', 'Meyer', 'Alvarez', 'Chen', 'Haddad', 'Petrov', 'Silva',
  'Nakamura', 'Kowalski', 'Diallo', 'Fernandez', 'Weber', 'Novak', 'Costa', 'Rahman', 'Moreau', 'Ivanova',
  'Sato', 'Andersson', 'Obi', 'Duarte', 'Kaminski', 'Farah', 'Larsen', 'Verma', 'Bianchi', 'Adeyemi']

const LOCATIONS = ['Berlin, Germany', 'London, United Kingdom', 'Austin, TX', 'Bengaluru, India', 'Toronto, Canada',
  'Amsterdam, Netherlands', 'Singapore', 'Dublin, Ireland', 'Warsaw, Poland', 'Barcelona, Spain',
  'New York, NY', 'Lisbon, Portugal', 'Tokyo, Japan', 'São Paulo, Brazil', 'Cape Town, South Africa']

const COMPANIES = ['Northwind Labs', 'Helios Systems', 'Vertex Digital', 'Bluepeak', 'Kestrel Analytics',
  'Onyx Commerce', 'Lumen Health', 'Arcadia Cloud', 'Tidewater Media', 'Foundry AI',
  'Meridian Bank', 'Cobalt Retail', 'Pinnacle Logistics', 'Aster Pharma', 'Vantage Mobility']

const SKILL_POOL = {
  engineering: ['TypeScript', 'React', 'Node.js', 'PostgreSQL', 'AWS', 'Kubernetes', 'Docker', 'GraphQL',
    'Python', 'Go', 'Terraform', 'CI/CD', 'Microservices', 'Redis', 'Kafka'],
  data: ['Python', 'SQL', 'Spark', 'Airflow', 'dbt', 'Snowflake', 'Pandas', 'Machine Learning',
    'PyTorch', 'TensorFlow', 'Tableau', 'Looker', 'A/B Testing'],
  product: ['Product Management', 'Roadmap', 'Stakeholder Management', 'Agile', 'Jira', 'User Research',
    'Figma', 'Analytics', 'Go-to-Market'],
  design: ['Figma', 'User Research', 'Prototyping', 'Design Systems', 'Accessibility', 'UI Design', 'UX Writing'],
  recruiting: ['Sourcing', 'ATS', 'Boolean Search', 'Interviewing', 'Employer Branding', 'HRIS', 'Compliance']
}

const EDUCATION = ['BSc Computer Science, TU Berlin', 'MSc Data Science, Imperial College London',
  'BEng Software Engineering, University of Waterloo', 'MBA, IESE Business School',
  'BSc Information Systems, NUS', 'MSc Human-Computer Interaction, TU Delft',
  'BSc Economics, University of Cape Town', 'MSc Statistics, University of Warsaw',
  'BA Design, Politecnico di Milano', 'BSc Mathematics, University of Toronto']

const JOBS = [
  { code: 'ENG-1042', title: 'Senior Frontend Engineer', dept: 'Engineering', loc: 'Berlin, Germany', mode: 'hybrid', type: 'full_time', sen: 'senior', status: 'open', pri: 'high', min: 95000, max: 125000, must: ['TypeScript', 'React', 'GraphQL'], nice: ['Next.js', 'Design Systems', 'Accessibility'], rec: 2, hm: 3, opened: 34, openings: 2 },
  { code: 'ENG-1046', title: 'Staff Platform Engineer', dept: 'Engineering', loc: 'London, United Kingdom', mode: 'remote', type: 'full_time', sen: 'staff', status: 'open', pri: 'urgent', min: 130000, max: 160000, must: ['Kubernetes', 'Terraform', 'AWS'], nice: ['Go', 'Kafka', 'CI/CD'], rec: 2, hm: 3, opened: 52, openings: 1 },
  { code: 'DAT-2011', title: 'Data Scientist, Growth', dept: 'Data', loc: 'Austin, TX', mode: 'hybrid', type: 'full_time', sen: 'mid', status: 'open', pri: 'normal', min: 110000, max: 140000, must: ['Python', 'SQL', 'Machine Learning'], nice: ['A/B Testing', 'PyTorch', 'Looker'], rec: 5, hm: 3, opened: 21, openings: 1 },
  { code: 'PRD-3007', title: 'Product Manager, Payments', dept: 'Product', loc: 'Amsterdam, Netherlands', mode: 'hybrid', type: 'full_time', sen: 'senior', status: 'paused', pri: 'normal', min: 100000, max: 130000, must: ['Product Management', 'Stakeholder Management'], nice: ['Analytics', 'Agile'], rec: 2, hm: 3, opened: 61, openings: 1 },
  { code: 'DES-4002', title: 'Product Designer', dept: 'Design', loc: 'Barcelona, Spain', mode: 'remote', type: 'full_time', sen: 'mid', status: 'open', pri: 'normal', min: 70000, max: 95000, must: ['Figma', 'User Research'], nice: ['Design Systems', 'Prototyping'], rec: 5, hm: 3, opened: 18, openings: 1 },
  { code: 'TAL-5001', title: 'Technical Recruiter', dept: 'Talent', loc: 'Dublin, Ireland', mode: 'hybrid', type: 'full_time', sen: 'mid', status: 'pending_approval', pri: 'high', min: 65000, max: 85000, must: ['Sourcing', 'ATS'], nice: ['Boolean Search', 'Employer Branding'], rec: 2, hm: 3, opened: null, openings: 1 },
  { code: 'ENG-1039', title: 'Backend Engineer, Payments', dept: 'Engineering', loc: 'Warsaw, Poland', mode: 'hybrid', type: 'full_time', sen: 'mid', status: 'filled', pri: 'high', min: 80000, max: 105000, must: ['Go', 'PostgreSQL', 'Kafka'], nice: ['Microservices', 'Redis'], rec: 2, hm: 3, opened: 96, openings: 1 },
  { code: 'ENG-1051', title: 'Engineering Manager, Platform', dept: 'Engineering', loc: 'Toronto, Canada', mode: 'hybrid', type: 'full_time', sen: 'lead', status: 'draft', pri: 'normal', min: 145000, max: 175000, must: ['Kubernetes', 'Stakeholder Management'], nice: ['Go', 'Terraform'], rec: null, hm: 3, opened: null, openings: 1 }
]

const PARSED = { skills: [], titles: [], employers: [], education: [] }
void PARSED

const main = async () => {
  const pw = await hashPassword('Password123!')

  w('-- VSolutions ATS v2.0 seed data (deterministic, generated by scripts/build-seed.mjs)')
  w("DELETE FROM automation_runs; DELETE FROM automation_event_queue; DELETE FROM automation_rules;")
  w("DELETE FROM message_events; DELETE FROM messages; DELETE FROM message_templates;")
  w("DELETE FROM talent_pool_members; DELETE FROM talent_pools;")
  w("DELETE FROM candidate_merges; DELETE FROM duplicate_reviews;")
  w("DELETE FROM ai_runs; DELETE FROM search_audit; DELETE FROM saved_searches;")
  w("DELETE FROM onboarding; DELETE FROM offers; DELETE FROM feedback;")
  w("DELETE FROM interview_participants; DELETE FROM interviews; DELETE FROM scorecard_templates;")
  w("DELETE FROM application_stage_history; DELETE FROM tasks;")
  w("DELETE FROM job_posting_events; DELETE FROM job_postings; DELETE FROM channels;")
  w("DELETE FROM offers; DELETE FROM applications; DELETE FROM candidate_index;")
  w("DELETE FROM candidate_tags; DELETE FROM candidate_notes; DELETE FROM candidate_consent;")
  w("DELETE FROM data_subject_requests; DELETE FROM resumes; DELETE FROM resume_jobs;")
  w("DELETE FROM candidates; DELETE FROM job_approvals; DELETE FROM jobs;")
  w("DELETE FROM sessions; DELETE FROM audit_events; DELETE FROM sla_settings;")
  w("DELETE FROM tags; DELETE FROM settings; DELETE FROM users;")
  w("DELETE FROM sqlite_sequence;")

  /* ------------------------------------------------------------- users */
  const users = [
    [1, 'admin@vsolutions.dev', 'Dana Whitfield', 'admin', 'Head of Talent Acquisition', 'People'],
    [2, 'recruiter@vsolutions.dev', 'Marco Reyes', 'recruiter', 'Senior Recruiter', 'Talent'],
    [3, 'manager@vsolutions.dev', 'Priya Raman', 'hiring_manager', 'Director of Engineering', 'Engineering'],
    [4, 'interviewer@vsolutions.dev', 'Jonas Berg', 'interviewer', 'Staff Engineer', 'Engineering'],
    [5, 'coordinator@vsolutions.dev', 'Amelia Fox', 'coordinator', 'Recruiting Coordinator', 'Talent'],
    [6, 'interviewer2@vsolutions.dev', 'Sofia Marchetti', 'interviewer', 'Principal Designer', 'Design'],
    [7, 'recruiter2@vsolutions.dev', 'Kwame Mensah', 'recruiter', 'Technical Recruiter', 'Talent']
  ]
  for (const [id, email, name, role, title, dept] of users) {
    w(`INSERT INTO users (id,email,name,role,title,department,password_hash,active) VALUES (${id},${q(email)},${q(name)},${q(role)},${q(title)},${q(dept)},${q(pw)},1);`)
  }

  w(`INSERT INTO settings (key,value) VALUES ('org_name',${q('VSolutions')}),('timezone',${q('UTC')}),('retention_months','24'),('mail_provider',${q('internal-sim')}),('sla_escalation_email',${q('talent-ops@vsolutions.dev')});`)

  /* -------------------------------------------------------- SLA settings */
  const SLAS = [['applied', 24], ['parsing', 6], ['screening', 48], ['recruiter_review', 72], ['manager_review', 48], ['interview', 120], ['offer', 72]]
  for (const [stage, hrs] of SLAS) {
    w(`INSERT INTO sla_settings (scope,stage,threshold_hours,escalate_to,enabled) VALUES ('stage',${q(stage)},${hrs},${q('talent-ops@vsolutions.dev')},1);`)
  }

  /* --------------------------------------------------------------- tags */
  const TAGS = ['High potential', 'Passive', 'Referral', 'Returning applicant', 'Diversity slate', 'Needs sponsorship', 'Senior', 'Remote only', 'Urgent', 'Silver medalist']
  TAGS.forEach((t, i) => w(`INSERT INTO tags (id,name,color) VALUES (${i + 1},${q(t)},${q(pick(['indigo', 'emerald', 'amber', 'rose', 'sky', 'violet']))});`))

  /* --------------------------------------------------------------- jobs */
  JOBS.forEach((j, i) => {
    const id = i + 1
    const opened = j.opened !== null ? iso(j.opened) : 'NULL'
    const submitted = j.status === 'draft' ? 'NULL' : iso((j.opened ?? 3) + 4)
    const approved = ['approved', 'open', 'paused', 'filled', 'closed'].includes(j.status) ? iso((j.opened ?? 3) + 2) : 'NULL'
    const filled = j.status === 'filled' ? iso(Math.max(1, (j.opened ?? 10) - 6)) : 'NULL'
    const desc = `We are hiring a ${j.title} to join the ${j.dept} team. You will work with a distributed team across ${j.loc} and partner closely with product and design. This is a ${j.mode} role.`
    const reqs = `Must have: ${j.must.join(', ')}. Nice to have: ${j.nice.join(', ')}. ${j.sen} level, ${j.type.replace('_', ' ')} employment.`
    w(`INSERT INTO jobs (id,code,title,department,location,work_mode,employment_type,seniority,description,requirements,must_have_skills,nice_to_have,salary_min,salary_max,currency,openings,status,priority,recruiter_id,hiring_manager_id,created_by,target_fill_date,created_at,updated_at,submitted_at,approved_at,opened_at,closed_at,filled_at) VALUES (` +
      [id, q(j.code), q(j.title), q(j.dept), q(j.loc), q(j.mode), q(j.type), q(j.sen), q(desc), q(reqs),
        q(JSON.stringify(j.must)), q(JSON.stringify(j.nice)), j.min, j.max, q('USD'), j.openings, q(j.status), q(j.pri),
        j.rec !== null ? j.rec : 'NULL', j.hm, 1,
        q(iso(-20 - i)), q(iso((j.opened ?? 1) + 5)), q(iso((j.opened ?? 1) + 1)),
        q(submitted), q(approved), q(opened),
        j.status === 'filled' ? q(filled) : 'NULL', q(filled)].join(',') + ');')
  })
  w(`INSERT INTO job_approvals (job_id,step,actor_id,decision,reason,created_at) VALUES (1,1,1,'approved','Budget confirmed for FY26.',${q(iso(36))}),(2,1,1,'approved','Critical platform hire.',${q(iso(54))}),(7,1,1,'approved','Backfill approved.',${q(iso(98))});`)

  /* -------------------------------------------------------- scorecards */
  w(`INSERT INTO scorecard_templates (id,name,job_id,stage,criteria,required,created_by) VALUES
    (1,'Engineering — Technical Screen',1,'interview',${q(JSON.stringify([
      { key: 'technical_depth', label: 'Technical depth', weight: 3, description: 'Can reason about complex frontend architecture' },
      { key: 'code_quality', label: 'Code quality', weight: 2, description: 'Writes maintainable, tested code' },
      { key: 'communication', label: 'Communication', weight: 2, description: 'Explains trade-offs clearly' },
      { key: 'collaboration', label: 'Collaboration', weight: 1, description: 'Works well across disciplines' }
    ]))},1,1),
    (2,'Platform — Systems Design',2,'interview',${q(JSON.stringify([
      { key: 'systems_design', label: 'Systems design', weight: 3, description: 'Designs resilient distributed systems' },
      { key: 'operational_excellence', label: 'Operational excellence', weight: 2, description: 'Owns reliability and observability' },
      { key: 'leadership', label: 'Technical leadership', weight: 2, description: 'Influences without authority' }
    ]))},1,1),
    (3,'Data — Analytics Depth',3,'interview',${q(JSON.stringify([
      { key: 'stats', label: 'Statistical rigour', weight: 3, description: 'Designs and interprets experiments' },
      { key: 'sql', label: 'SQL & modelling', weight: 2, description: 'Writes efficient analytical SQL' },
      { key: 'product_sense', label: 'Product sense', weight: 2, description: 'Connects analysis to decisions' }
    ]))},1,1),
    (4,'Design — Portfolio Review',5,'interview',${q(JSON.stringify([
      { key: 'craft', label: 'Design craft', weight: 3, description: 'Visual and interaction quality' },
      { key: 'research', label: 'Research rigour', weight: 2, description: 'Grounds decisions in evidence' },
      { key: 'collaboration', label: 'Collaboration', weight: 1, description: 'Partners with engineering and PM' }
    ]))},1,1);`)

  /* ---------------------------------------------------------- candidates */
  const CANDIDATE_COUNT = 64
  const candidates = []
  const usedEmails = new Set()
  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const id = i + 1
    const first = FIRST[i % FIRST.length]
    const last = LAST[(i * 7) % LAST.length]
    let email = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@example.com'
    if (usedEmails.has(email)) email = email.replace('@', `${i}@`)
    usedEmails.add(email)
    const loc = LOCATIONS[i % LOCATIONS.length]
    const domain = pick(Object.keys(SKILL_POOL))
    const skills = [...new Set([...SKILL_POOL[domain].slice(0, int(3, 6)), ...SKILL_POOL[pick(Object.keys(SKILL_POOL))].slice(0, 2)])]
    const employer = COMPANIES[(i * 3) % COMPANIES.length]
    const exp = int(2, 14)
    const cand = {
      id, first, last, email,
      phone: `+${int(1, 49)} ${int(100, 999)} ${int(1000, 9999)}`,
      location: loc,
      country: loc.split(', ').pop(),
      headline: `${pick(['Senior', 'Staff', 'Mid-level', 'Lead', 'Principal'])} ${domain === 'engineering' ? pick(['Frontend Engineer', 'Backend Engineer', 'Full-stack Engineer', 'Platform Engineer']) : domain === 'data' ? pick(['Data Scientist', 'Data Engineer', 'Analytics Engineer']) : domain === 'product' ? 'Product Manager' : domain === 'design' ? pick(['Product Designer', 'UX Designer']) : 'Technical Recruiter'}`,
      employer,
      education: EDUCATION[i % EDUCATION.length],
      exp,
      notice: pick([15, 30, 30, 45, 60, 90]),
      expected: int(65, 165) * 1000,
      skills,
      domain,
      summary: '',
      source: pick(['LinkedIn', 'Referral', 'Careers site', 'Agency', 'Job board', 'Talent pool', 'Event']),
      consent: chance(0.75) ? 'opt_in' : chance(0.5) ? 'unknown' : 'opt_out',
      createdAgo: int(1, 120)
    }
    cand.summary = `${cand.headline} with ${exp} years of experience across ${skills.slice(0, 3).join(', ')}. Currently at ${employer} in ${loc}.`
    candidates.push(cand)

    w(`INSERT INTO candidates (id,first_name,last_name,email,phone,location,country,headline,current_employer,education,experience_years,notice_period_days,current_salary,expected_salary,availability,summary,linkedin,source,status,consent_status,retention_until,created_by,created_at,updated_at) VALUES (` +
      [id, q(first), q(last), q(email), q(cand.phone), q(loc), q(cand.country), q(cand.headline), q(employer),
        q(cand.education), exp, cand.notice, cand.expected - int(5, 25) * 1000, cand.expected,
        q(pick(['Immediately', '1 month', '2 months', '3 months'])), q(cand.summary),
        q(`https://linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}-${id}`), q(cand.source),
        q('active'), q(cand.consent), qd(iso(-int(200, 700))), 2, qd(iso(cand.createdAgo)), qd(iso(cand.createdAgo))].join(',') + ');')

    // resume text — richer for higher ids so parsing has material
    const resumeText = [
      `${first} ${last}`,
      `${cand.headline} · ${loc} · ${email} · ${cand.phone}`,
      '',
      'SUMMARY',
      cand.summary,
      `Core skills: ${skills.join(', ')}.`,
      '',
      'EXPERIENCE',
      `${employer} — ${pick(['Senior', 'Lead', 'Staff'])} ${domain === 'engineering' ? 'Engineer' : domain === 'data' ? 'Data Scientist' : 'Specialist'} (${2026 - exp} - Present)`,
      `Led delivery of platform initiatives using ${skills.slice(0, 3).join(', ')}. Partnered with product and design across 3 time zones.`,
      '',
      'EDUCATION',
      cand.education,
      '',
      'SKILLS',
      skills.join(' · ')
    ].join('\n')

    w(`INSERT INTO resumes (id,candidate_id,filename,mime_type,size_bytes,raw_text,parsed_json,parse_confidence,status,attempts,is_primary,created_by,created_at,updated_at) VALUES (` +
      [id, id, q(`${first}_${last}_CV.pdf`), q('application/pdf'), int(40000, 240000), q(resumeText),
        q(JSON.stringify({ skills, titles: [cand.headline], employers: [employer], education: [cand.education] })),
        (0.72 + (i % 20) / 100).toFixed(2), q('screening_ready'), 1, 1, 2, qd(iso(cand.createdAgo)), qd(iso(cand.createdAgo))].join(',') + ');')

    // index
    const blob = [first, last, email, loc, cand.country, cand.headline, employer, cand.education, cand.summary, skills.join(' '), resumeText].join(' ')
    w(`INSERT INTO candidate_index (candidate_id,search_blob,skills,titles,employers,education,locations,resume_text,updated_at) VALUES (` +
      [id, q(blob), q(skills.join(', ')), q(cand.headline), q(employer), q(cand.education), q(loc), q(resumeText), qd(iso(cand.createdAgo))].join(',') + ');')

    if (chance(0.5)) {
      w(`INSERT INTO candidate_tags (candidate_id,tag_id,tagged_by) VALUES (${id},${int(1, TAGS.length)},2);`)
    }
    w(`INSERT INTO candidate_consent (candidate_id,channel,status,source,updated_by) VALUES (${id},'email',${q(cand.consent)},${q('import')},2);`)
  }

  /* ------------------------------------- deliberate duplicates (ATS-02) --- */
  // Duplicate 65 mirrors 1 by email; 66 mirrors 2 by phone
  const c1 = candidates[0], c2 = candidates[1]
  w(`INSERT INTO candidates (id,first_name,last_name,email,phone,location,country,headline,current_employer,education,experience_years,notice_period_days,expected_salary,summary,source,status,consent_status,created_by,created_at,updated_at) VALUES
    (65,${q(c1.first)},${q(c1.last)},${q(c1.email)},${q('+49 30 5550 118')},${q(c1.location)},${q(c1.country)},${q(c1.headline)},${q('Northwind Labs GmbH')},${q(c1.education)},${c1.exp},30,${c1.expected},${q('Duplicate record created by an agency import.')},${q('Agency')},'active','opt_in',2,${q(iso(9))},${q(iso(9))}),
    (66,${q(c2.first)},${q(c2.last)},${q('a.' + c2.email)},${q(c2.phone)},${q(c2.location)},${q(c2.country)},${q(c2.headline)},${q(c2.employer)},${q(c2.education)},${c2.exp},30,${c2.expected},${q('Duplicate record from careers site re-apply.')},${q('Careers site')},'active','opt_in',2,${q(iso(6))},${q(iso(6))});`)
  for (const [rid, cid] of [[65, 65], [66, 66]]) {
    w(`INSERT INTO resumes (id,candidate_id,filename,mime_type,size_bytes,raw_text,parsed_json,parse_confidence,status,attempts,is_primary,created_by,created_at,updated_at) VALUES (${rid},${cid},'imported_cv.pdf','application/pdf',88000,${q(`Imported resume for ${cid}`)},'{}',0.55,'screening_ready',1,1,2,${q(iso(7))},${q(iso(7))});`)
    w(`INSERT INTO candidate_index (candidate_id,search_blob,skills,titles,employers,education,locations,resume_text,updated_at) VALUES (${cid},${q('imported duplicate record ' + (cid === 65 ? c1.skills.join(' ') : c2.skills.join(' ')))},${q((cid === 65 ? c1.skills : c2.skills).join(', '))},${q(cid === 65 ? c1.headline : c2.headline)},${q(cid === 65 ? 'Northwind Labs GmbH' : c2.employer)},${q(cid === 65 ? c1.education : c2.education)},${q(cid === 65 ? c1.location : c2.location)},${q('imported duplicate resume text')},${q(iso(7))});`)
  }
  w(`INSERT INTO duplicate_reviews (primary_id,duplicate_id,score,signals,status,created_at) VALUES
    (1,65,0.55,${q(JSON.stringify([{ signal: 'email', weight: 0.55, detail: 'identical email' }]))},'pending',${q(iso(9))}),
    (2,66,0.35,${q(JSON.stringify([{ signal: 'phone', weight: 0.35, detail: 'identical phone' }]))},'pending',${q(iso(6))});`)

  /* ------------------------------------------------------- applications */
  const appRows = []
  const stagePool = [
    ['applied', 16], ['parsing', 3], ['screening', 10], ['recruiter_review', 9],
    ['manager_review', 6], ['interview', 8], ['offer', 4], ['hired', 3]
  ]
  let appId = 1
  const statusMix = { rejected: 7, withdrawn: 3, on_hold: 2 }
  let rejectedLeft = statusMix.rejected, withdrawnLeft = statusMix.withdrawn, holdLeft = statusMix.on_hold
  const seenPair = new Set()

  for (const [stage, count] of stagePool) {
    for (let k = 0; k < count; k++) {
      const cand = candidates[(appId * 5 + k) % 60]
      const jobIdx = (appId * 3) % 6  // jobs 1..6 are the live ones
      const job = JOBS[jobIdx]
      if (!['open', 'paused', 'filled'].includes(job.status) && stage !== 'applied') continue
      // one application per candidate per requisition (ATS-11 invariant)
      const pair = `${cand.id}:${jobIdx + 1}`
      if (seenPair.has(pair)) continue
      seenPair.add(pair)
      const daysAgo = int(3, 70)
      const status = stage === 'hired' ? 'hired'
        : rejectedLeft > 0 && chance(0.55) ? (rejectedLeft--, 'rejected')
          : withdrawnLeft > 0 && chance(0.2) ? (withdrawnLeft--, 'withdrawn')
            : holdLeft > 0 && chance(0.15) ? (holdLeft--, 'on_hold') : 'active'
      const source = cand.source
      appRows.push({
        id: appId, candId: cand.id, jobId: jobIdx + 1, stage, status, source,
        recruiter: job.rec ?? 2, daysAgo,
        rejection: status === 'rejected' ? pick(['Skills mismatch', 'Salary expectation', 'Failed technical screen', 'Position filled internally', 'Experience level']) : null,
        drop: status === 'withdrawn' ? pick(['Accepted another offer', 'Withdrew — compensation', 'Location/travel', 'No response']) : null
      })
      appId++
    }
  }

  // Guarantee cross-application history for ATS-11: recruiters 1..5 apply to 2-3 jobs
  for (const base of [1, 2, 3, 4, 5]) {
    for (const jid of [1, 2, 3]) {
      const exists = appRows.some((a) => a.candId === base && a.jobId === jid)
      if (exists) continue
      appRows.push({
        id: appId, candId: base, jobId: jid, stage: pick(['applied', 'screening', 'recruiter_review']),
        status: 'active', source: candidates[base - 1].source, recruiter: 2, daysAgo: int(4, 40),
        rejection: null, drop: null
      })
      appId++
    }
  }

  for (const a of appRows) {
    const appliedAt = iso(a.daysAgo)
    const stageEntered = a.stage === 'applied' ? appliedAt : iso(Math.max(1, a.daysAgo - int(1, Math.min(a.daysAgo, 8))))
    const firstReview = ['recruiter_review', 'manager_review', 'interview', 'offer', 'hired'].includes(a.stage) ? iso(Math.max(1, a.daysAgo - 2)) : 'NULL'
    const closed = ['rejected', 'withdrawn', 'hired'].includes(a.status) ? iso(Math.max(1, Math.floor(a.daysAgo / 2))) : 'NULL'
    const match = (55 + ((a.id * 7) % 40)).toFixed(1)
    w(`INSERT INTO applications (id,candidate_id,job_id,stage,status,source,source_detail,recruiter_id,match_score,rejection_reason,drop_off_reason,stage_entered_at,applied_at,first_review_at,decision_at,closed_at,created_at,updated_at) VALUES (` +
      [a.id, a.candId, a.jobId, q(a.stage), q(a.status), q(a.source), q(pick(['Direct', 'Campaign Q4', 'Referral bonus', 'Sourced — LinkedIn Recruiter'])),
        a.recruiter, match, q(a.rejection), q(a.drop), q(stageEntered), q(appliedAt), q(firstReview), 'NULL', q(closed), q(appliedAt), q(stageEntered)].join(',') + ');')

    // stage history: applied → ... → current
    const ORDER = ['applied', 'parsing', 'screening', 'recruiter_review', 'manager_review', 'interview', 'offer', 'hired']
    const upto = ORDER.indexOf(a.stage)
    for (let s = 0; s <= upto; s++) {
      const at = iso(Math.max(0, a.daysAgo - s * 2 - (s > 0 ? 1 : 0)))
      w(`INSERT INTO application_stage_history (application_id,from_stage,to_stage,from_status,to_status,actor_id,reason,created_at) VALUES (${a.id},${s === 0 ? 'NULL' : q(ORDER[s - 1])},${q(ORDER[s])},${s === 0 ? 'NULL' : q('active')},${q(s === upto ? a.status : 'active')},${s <= 2 ? 2 : 3},${s === 0 ? q('Application received') : 'NULL'},${q(at)});`)
    }
  }
  w(`UPDATE applications SET stage_entered_at = applied_at WHERE stage = 'applied';`)

  /* --------------------------------------------------------- interviews */
  let intId = 1, fbId = 1
  const interviewApps = appRows.filter((a) => ['interview', 'offer', 'hired'].includes(a.stage) || a.status === 'rejected' && a.stage === 'interview')
  for (const a of interviewApps) {
    const rounds = a.stage === 'hired' || a.stage === 'offer' ? 2 : 1
    for (let r = 1; r <= rounds; r++) {
      const status = a.stage === 'hired' || a.stage === 'offer' ? 'feedback_complete'
        : rnd() < 0.45 ? 'feedback_complete' : rnd() < 0.5 ? 'feedback_pending' : 'scheduled'
      const scheduled = iso(Math.max(0, a.daysAgo - 3 - r))
      const completed = ['feedback_complete', 'feedback_pending'].includes(status) ? iso(Math.max(0, a.daysAgo - 4 - r)) : null
      const tplId = a.jobId <= 2 ? (a.jobId === 1 ? 1 : 2) : a.jobId === 3 ? 3 : a.jobId === 5 ? 4 : 1
      w(`INSERT INTO interviews (id,application_id,round,title,mode,scheduled_at,duration_min,location,meeting_link,status,feedback_due_at,completed_at,scorecard_template_id,created_by,created_at,updated_at) VALUES (` +
        [intId, a.id, r, q(r === 1 ? 'Technical screen' : 'Panel interview'), q(pick(['video', 'video', 'phone'])),
          qd(scheduled), 45, q('Remote'), q(`https://meet.vsolutions.dev/${intId}`), q(status), qd(iso(Math.max(0, a.daysAgo - 5 - r))),
          qd(completed), tplId, 5, qd(iso(a.daysAgo - 2)), qd(scheduled)].join(',') + ');')

      const panel = r === 1 ? [(4)] : [4, 6]
      for (const uid of panel) {
        w(`INSERT INTO interview_participants (interview_id,user_id,role) VALUES (${intId},${uid},${q(uid === 4 ? 'lead' : 'interviewer')});`)
        if (['feedback_complete', 'feedback_pending'].includes(status)) {
          const submitted = status === 'feedback_complete'
          const scores = [
            { criterion: 'technical_depth', score: int(2, 5), note: pick(['Solid systems reasoning', 'Struggled with edge cases', 'Deep expertise', 'Adequate but shallow']) },
            { criterion: 'code_quality', score: int(2, 5), note: pick(['Clean and tested', 'Some duplication', 'Well structured']) },
            { criterion: 'communication', score: int(3, 5), note: pick(['Clear trade-off discussion', 'Occasionally vague']) }
          ]
          const overall = Math.round(scores.reduce((s, x) => s + x.score, 0) / scores.length)
          const rec = overall >= 4 ? 'yes' : overall === 3 ? 'mixed' : 'no'
          const evidence = submitted ? `Discussed past projects at ${pick(COMPANIES)}; candidate described ${pick(['migration of a monolith', 'design system adoption', 'real-time data pipeline', 'payments reconciliation'])} and explained trade-offs around ${pick(['caching', 'consistency', 'latency'])}.` : null
          w(`INSERT INTO feedback (id,interview_id,interviewer_id,scores_json,overall,recommendation,evidence,status,version,submitted_at,updated_at) VALUES (` +
            [fbId, intId, uid, q(JSON.stringify(scores)), overall, q(rec), q(evidence), q(submitted ? 'submitted' : 'draft'),
              1, submitted ? qd(completed) : 'NULL', qd(completed || scheduled)].join(',') + ');')
          fbId++
        }
      }
      intId++
    }
  }

  /* ------------------------------------------------------------- offers */
  let offerId = 1
  for (const a of appRows.filter((x) => ['offer', 'hired'].includes(x.stage))) {
    const cand = candidates.find((c) => c.id === a.candId)
    const job = JOBS[a.jobId - 1]
    const isHired = a.stage === 'hired'
    const status = isHired ? 'accepted' : pick(['released', 'approval_pending', 'approved', 'declined'])
    const released = ['released', 'accepted', 'declined'].includes(status) ? iso(Math.max(0, a.daysAgo - 8)) : 'NULL'
    w(`INSERT INTO offers (id,application_id,version,status,base_salary,bonus,equity,currency,start_date,expires_at,notes,approved_by,approved_at,released_at,responded_at,response_note,created_by,created_at,updated_at) VALUES (` +
      [offerId, a.id, 1, q(status), job.min + int(0, 15) * 1000, int(5, 20) * 1000,
        q(pick(['0.05% over 4y', '0.1% over 4y', 'None'])), q('USD'), q(iso(-30)), q(iso(-10)),
        q('Standard package per band 4.'), ['approved', 'released', 'accepted', 'declined'].includes(status) ? 1 : 'NULL',
        q(['approved', 'released', 'accepted', 'declined'].includes(status) ? iso(Math.max(0, a.daysAgo - 6)) : null),
        q(released), q(isHired ? iso(Math.max(0, a.daysAgo - 9)) : status === 'declined' ? iso(Math.max(0, a.daysAgo - 5)) : null),
        isHired ? q('Accepted — start date confirmed.') : status === 'declined' ? q('Declined — accepted a competing offer.') : 'NULL',
        2, q(iso(a.daysAgo - 5)), q(iso(a.daysAgo - 9))].join(',') + ');')
    offerId++
  }

  /* ---------------------------------------------------------- onboarding */
  let onbId = 1
  for (const a of appRows.filter((x) => x.stage === 'hired')) {
    const st = pick(['joined', 'ready_to_join', 'pending_documents', 'initiated'])
    const tasks = [
      { key: 'contract', label: 'Sign employment contract', done: st !== 'initiated' },
      { key: 'id', label: 'Upload ID documents', done: st === 'ready_to_join' || st === 'joined' },
      { key: 'equipment', label: 'Select equipment', done: st === 'joined' },
      { key: 'orientation', label: 'Book orientation', done: st === 'joined' }
    ]
    w(`INSERT INTO onboarding (id,application_id,status,tasks_json,start_date,initiated_at,ready_at,joined_at,updated_at) VALUES (` +
      [onbId, a.id, q(st), q(JSON.stringify(tasks)), q(iso(-30)),
        q(iso(Math.max(0, a.daysAgo - 8))), st === 'ready_to_join' || st === 'joined' ? q(iso(-12)) : 'NULL',
        st === 'joined' ? q(iso(-5)) : 'NULL', q(iso(-5))].join(',') + ');')
    onbId++
  }

  /* --------------------------------------------- channels & postings (03) */
  const CHANNELS = [
    ['Company careers site', 'internal', 1, 1],
    ['LinkedIn Jobs', 'job_board', 1, 1],
    ['Indeed', 'job_board', 1, 1],
    ['Glassdoor', 'job_board', 0, 1],
    ['Google Jobs', 'aggregator', 0, 1],
    ['X / Twitter', 'social', 0, 0]
  ]
  CHANNELS.forEach((c, i) => {
    w(`INSERT INTO channels (id,name,type,api_supported,enabled,field_mapping,notes) VALUES (${i + 1},${q(c[0])},${q(c[1])},${c[2]},${c[3]},${q(JSON.stringify({ title: 'title', description: 'description', location: 'location', salary: 'salary_min-salary_max' }))},${q(c[2] ? 'Live API integration available.' : 'Manual export only — no supported partner publishing API.')});`)
  })

  let postId = 1
  for (const job of JOBS.filter((j) => ['open', 'paused', 'filled', 'pending_approval'].includes(j.status))) {
    const jobId = JOBS.indexOf(job) + 1
    for (const ch of [1, 2, 3, 4]) {
      const apiOk = ch <= 3
      const status = job.status === 'paused' ? 'expired'
        : job.status === 'filled' ? 'withdrawn'
          : ch === 4 ? 'failed'
            : chance(0.85) ? 'published' : 'queued'
      w(`INSERT INTO job_postings (id,job_id,channel_id,status,external_id,external_url,payload_json,attempts,last_error,posted_at,expires_at,withdrawn_at,created_by,created_at,updated_at) VALUES (` +
        [postId, jobId, ch, q(status), q(status === 'published' ? `ext-${jobId}-${ch}-${int(1000, 9999)}` : null),
          q(status === 'published' ? `https://jobs.example.com/${job.code.toLowerCase()}-${ch}` : null),
          q(JSON.stringify({ title: job.title, location: job.loc, salary: `${job.min}-${job.max} USD`, description_length: 1200 })),
          status === 'published' ? 1 : status === 'failed' ? 2 : 0,
          q(status === 'failed' ? 'Channel does not expose a public publishing API — manual export required.' : null),
          status === 'published' ? q(iso(job.opened ?? 5)) : 'NULL',
          q(iso(-25)), status === 'withdrawn' ? q(iso(3)) : 'NULL', 2, q(iso(job.opened ?? 5)), q(iso(3))].join(',') + ');')
      w(`INSERT INTO job_posting_events (posting_id,action,status,detail,actor_id,created_at) VALUES (${postId},'publish',${q(status)},${q(status === 'failed' ? 'Rejected by channel: no API access' : `Posting ${status}`)},2,${q(iso(job.opened ?? 5))});`)
      postId++
    }
  }

  /* ------------------------------------------------------- templates (04) */
  const TEMPLATES = [
    ['Application received', 'acknowledgement', 'We received your application for {{job_title}}', 'Hi {{first_name}},\n\nThanks for applying to {{job_title}} at VSolutions. Our team is reviewing your background and will be in touch within 5 business days.\n\nBest,\nVSolutions Talent Team'],
    ['Screening invite', 'screening', 'Next step: screening call for {{job_title}}', 'Hi {{first_name}},\n\nWe would like to schedule a 30-minute screening call for {{job_title}}. Please share two or three times that work for you.\n\nBest,\nVSolutions Talent Team'],
    ['Interview invitation', 'interview_invite', 'Interview invitation — {{job_title}}', 'Hi {{first_name}},\n\nYou have been invited (or have accepted an invitation) to interview for {{job_title}}. Your interviewer panel details are on your candidate portal.\n\nBest,\nVSolutions Talent Team'],
    ['Reschedule confirmation', 'reschedule', 'Your interview has been rescheduled', 'Hi {{first_name}},\n\nYour interview for {{job_title}} has been moved. The new time is confirmed in your candidate portal.\n\nBest,\nVSolutions Talent Team'],
    ['Not moving forward', 'rejection', 'Update on your application — {{job_title}}', 'Hi {{first_name}},\n\nThank you for your time. After careful review we will not be moving forward with your application for {{job_title}}.\n\nWe would welcome you applying for future roles.\n\nBest,\nVSolutions Talent Team'],
    ['Offer released', 'offer', 'Your offer for {{job_title}}', 'Hi {{first_name}},\n\nWe are delighted to share an offer for {{job_title}}. The full package and start date are available in the attachment.\n\nBest,\nVSolutions Talent Team'],
    ['Withdrawal acknowledgement', 'withdrawal', 'We received your withdrawal', 'Hi {{first_name}},\n\nWe have noted your withdrawal from {{job_title}}. Thank you for letting us know.\n\nBest,\nVSolutions Talent Team']
  ]
  TEMPLATES.forEach((t, i) => {
    w(`INSERT INTO message_templates (id,name,category,channel,subject,body,active,created_by) VALUES (${i + 1},${q(t[0])},${q(t[1])},'email',${q(t[2])},${q(t[3])},1,1);`)
  })

  let msgId = 1
  for (const a of appRows.slice(0, 40)) {
    const cand = candidates.find((c) => c.id === a.candId)
    if (!cand || cand.consent === 'opt_out') continue
    const tplIdx = a.stage === 'applied' ? 0 : a.stage === 'screening' ? 1 : ['interview', 'offer', 'hired'].includes(a.stage) ? 2 : 0
    const tpl = TEMPLATES[tplIdx]
    const status = chance(0.85) ? 'sent' : chance(0.5) ? 'failed' : 'bounced'
    w(`INSERT INTO messages (id,candidate_id,application_id,template_id,channel,to_address,subject,body,status,provider,provider_message_id,error,sent_at,created_by,created_at) VALUES (` +
      [msgId, cand.id, a.id, tplIdx + 1, q('email'), q(cand.email),
        q(tpl[2].replace(/\{\{job_title\}\}/g, JOBS[a.jobId - 1].title)),
        q(tpl[3].replace(/\{\{first_name\}\}/g, cand.first).replace(/\{\{job_title\}\}/g, JOBS[a.jobId - 1].title)),
        q(status), q('internal-sim'), status === 'sent' ? q(`sim-${msgId}-${int(10000, 99999)}`) : 'NULL',
        status === 'failed' ? q('SMTP 421: temporary failure') : status === 'bounced' ? q('Mailbox unavailable (550)') : 'NULL',
        status === 'sent' ? q(iso(Math.max(0, a.daysAgo - 1))) : 'NULL', 2, q(iso(a.daysAgo))].join(',') + ');')
    msgId++
  }

  /* ---------------------------------------------------------- pools (08) */
  const POOLS = [
    ['Senior Engineers — EMEA', 'pool', 'Pre-vetted senior engineers open to hybrid roles in Germany and the UK.', 2, 'team'],
    ['Design Silver Medalists', 'pool', 'Strong designers who finished second for past roles.', 2, 'team'],
    ['Data Science Pipeline', 'pool', 'Analytics and ML candidates sourced in Q3/Q4.', 7, 'team'],
    ['Q4 Referral Folder', 'folder', 'Referred candidates for the Q4 hiring push.', 2, 'private'],
    ['Past Applicants — Product', 'pool', 'Previous product applicants eligible for rediscovery.', 2, 'team']
  ]
  POOLS.forEach((p, i) => w(`INSERT INTO talent_pools (id,name,description,kind,owner_id,visibility,created_at) VALUES (${i + 1},${q(p[0])},${q(p[2])},${q(p[1])},${p[3]},${q(p[4])},${q(iso(60 - i * 5))});`))
  let pmId = 1
  for (let p = 1; p <= 5; p++) {
    const size = int(6, 12)
    for (let k = 0; k < size; k++) {
      const cand = candidates[(p * 11 + k * 3) % 60]
      w(`INSERT INTO talent_pool_members (id,pool_id,candidate_id,added_by,source,notes,last_contact_at,re_engagement,created_at) VALUES (` +
        [pmId, p, cand.id, 2, q(cand.source), q(pick(['Strong technical signal', 'Good culture fit', 'Awaiting headcount', 'Wants remote only'])),
          chance(0.6) ? q(iso(int(5, 90))) : 'NULL',
          q(pick(['not_contacted', 'contacted', 'interested', 'not_interested', 'hired'])), q(iso(int(5, 60)))].join(',') + ');')
      pmId++
    }
  }

  /* --------------------------------------------------- saved searches (01) */
  w(`INSERT INTO saved_searches (owner_id,name,query,mode,filters,pool_id,shared) VALUES
    (2,'Senior React — Berlin','title:senior AND skill:react AND location:berlin','boolean',${q(JSON.stringify({ minExperience: 5, maxNotice: 60 }))},1,1),
    (2,'Platform engineers (AWS/K8s)','(skill:kubernetes OR skill:terraform) AND NOT title:manager','boolean',${q(JSON.stringify({ minExperience: 6 }))},NULL,1),
    (7,'Data scientists — ML depth','machine learning engineer building models in production','semantic',${q(JSON.stringify({ maxSalary: 150000 }))},3,0);`)

  /* ------------------------------------------------------ automation (05) */
  w(`INSERT INTO automation_rules (id,name,description,trigger_event,conditions,actions,enabled,test_mode,created_by) VALUES
    (1,'Acknowledge every new application','Sends the acknowledgement template when an application is created.','application.created',${q(JSON.stringify([{ field: 'consent_status', op: 'neq', value: 'opt_out' }]))},${q(JSON.stringify([{ type: 'send_message', template_id: 1 }]))},1,0,1),
    (2,'Create manager review task on shortlist','When an application moves to manager review, create a task for the hiring manager.','application.stage_changed',${q(JSON.stringify([{ field: 'to_stage', op: 'eq', value: 'manager_review' }]))},${q(JSON.stringify([{ type: 'create_task', type_: 'review', title: 'Hiring manager review required', due_in_hours: 48 }]))},1,0,1),
    (3,'Feedback reminder after interview','Creates a reminder task when an interview is completed.','interview.completed',${q(JSON.stringify([]))},${q(JSON.stringify([{ type: 'create_task', type_: 'feedback', title: 'Collect interview feedback', due_in_hours: 24 }]))},1,0,1),
    (4,'Requisition aging alert','Notifies talent ops when an open requisition passes 45 days.','job.aged',${q(JSON.stringify([{ field: 'days_open', op: 'gt', value: 45 }]))},${q(JSON.stringify([{ type: 'notify_user', title: 'Requisition past 45 days', user_id: 1 }]))},1,0,1),
    (5,'Reject acknowledgement (test mode)','Would send a rejection note; kept in test mode for review.','application.rejected',${q(JSON.stringify([]))},${q(JSON.stringify([{ type: 'send_message', template_id: 5 }]))},1,1,1),
    (6,'Interview invite on scheduling','Sends invitation details when an interview is scheduled.','interview.scheduled',${q(JSON.stringify([]))},${q(JSON.stringify([{ type: 'send_message', template_id: 3 }]))},0,0,1);`)

  w(`INSERT INTO automation_runs (rule_id,event_key,event_name,entity_ref,status,detail,attempts,created_at) VALUES
    (1,'seed-evt-1','application.created','application:3','success','message_sent',1,${q(iso(12))}),
    (2,'seed-evt-2','application.stage_changed','application:9','success','task_created',1,${q(iso(10))}),
    (3,'seed-evt-3','interview.completed','interview:4','success','task_created',1,${q(iso(8))}),
    (5,'seed-evt-5','application.rejected','application:14','test','test:send_message',1,${q(iso(6))}),
    (1,'seed-evt-6','application.created','application:22','failed','error:template_missing',2,${q(iso(4))}),
    (2,'seed-evt-7','application.stage_changed','application:31','skipped','condition_failed:to_stage',1,${q(iso(2))});`)

  /* ------------------------------------------------------------- tasks */
  w(`INSERT INTO tasks (type,title,detail,application_id,job_id,assignee_id,due_at,status,created_by,created_at) VALUES
    ('review','Hiring manager review required','Shortlisted candidate awaiting manager decision.',9,2,3,${q(iso(-1))},'open',2,${q(iso(4))}),
    ('feedback','Collect interview feedback','Two interviewers have not submitted scorecards.',12,1,4,${q(iso(-2))},'overdue',5,${q(iso(6))}),
    ('approval','Approve offer — Backend Engineer','Offer awaiting approval before release.',null,7,1,${q(iso(-3))},'open',2,${q(iso(5))}),
    ('onboarding','Send onboarding pack','Prepare documents for the accepted candidate.',null,null,5,${q(iso(2))},'open',5,${q(iso(3))});`)

  /* --------------------------------------------------------- audit trail */
  w(`INSERT INTO audit_events (entity_type,entity_id,action,actor_id,previous_value,new_value,reason,created_at) VALUES
    ('job','1','status_changed',1,'approved','open','Requisition opened after approval',${q(iso(34))}),
    ('job','7','status_changed',1,'open','filled','Offer accepted by candidate',${q(iso(6))}),
    ('application','9','stage_changed',2,'screening','recruiter_review','Strong technical signal',${q(iso(5))}),
    ('application','12','stage_changed',3,'recruiter_review','manager_review',NULL,${q(iso(4))}),
    ('offer','1','status_changed',1,'approved','released','Released to candidate',${q(iso(7))}),
    ('candidate','1','created',2,NULL,NULL,'Imported from LinkedIn',${q(iso(118))});`)

  /* --------------------------------------------------------- AI run log */
  w(`INSERT INTO ai_runs (kind,entity_ref,engine,output,created_by,created_at) VALUES
    ('summary','candidate:1:job:1','rubric-evidence-v1',${q(JSON.stringify({ fit_score: 82, criteria_met: 2 }))},2,${q(iso(3))}),
    ('comparison','job:1','rubric-evidence-v1',${q(JSON.stringify({ ranked: 3 }))},2,${q(iso(2))}),
    ('feedback_summary','application:12','feedback-consensus-v1',${q(JSON.stringify({ feedback_count: 2 }))},2,${q(iso(1))});`)

  writeFileSync(new URL('../seed.sql', import.meta.url), lines.join('\n') + '\n')
  console.log(`seed.sql written: ${lines.length} statements`)
}

main().catch((e) => { console.error(e); process.exit(1) })
