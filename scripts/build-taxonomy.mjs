#!/usr/bin/env node
/**
 * Deterministic generator for migrations/0005_taxonomy_seed.sql
 *
 * N8: the taxonomy is a governed artefact. This script is the only writer of
 * the *seed*; runtime additions must arrive as `taxonomy_suggestions` and are
 * approved by a human before they become an active version.
 *
 * Explicit ids are emitted so parent/edge links are stable across rebuilds.
 */
import { writeFileSync } from 'node:fs'

/* ------------------------------------------------------------------ data */
const INDUSTRY = { code: 'AUTO', name: 'Automotive', desc: 'Automotive OEM, tier-1 and mobility engineering' }

const LEVELS = [
  ['INTERN', 'Intern', 0.5], ['ENTRY', 'Entry (0-2 yrs)', 1], ['MID', 'Mid (2-5 yrs)', 3],
  ['SENIOR', 'Senior (5-9 yrs)', 7], ['LEAD', 'Lead (9-14 yrs)', 11], ['PRINCIPAL', 'Principal (14+ yrs)', 16]
]

const DOMAINS = [
  {
    code: 'VEH_ENG', name: 'Vehicle Engineering & Design',
    subdomains: ['Body & Chassis', 'NVH', 'CAE & Simulation', 'Thermal & Climate'],
    roles: [
      { code: 'BIW_ENG', name: 'Body-in-White Engineer', skills: ['BIW Design', 'Sheet Metal Design', 'GD&T', 'Catia V5', 'Weld Planning'] },
      { code: 'CHASSIS_ENG', name: 'Chassis Engineer', skills: ['Suspension Design', 'Braking Systems', 'GD&T', 'Vehicle Dynamics'] },
      { code: 'NVH_ENG', name: 'NVH Engineer', skills: ['NVH Testing', 'Modal Analysis', 'Acoustic Packaging', 'Signal Processing'] },
      { code: 'CAE_ENG', name: 'CAE Analyst', skills: ['FEA', 'Crash Simulation', 'HyperMesh', 'LS-DYNA', 'Modal Analysis'] },
      { code: 'THERMAL_ENG', name: 'Thermal Systems Engineer', skills: ['Thermal Management', 'CFD', 'HVAC Systems'] }
    ]
  },
  {
    code: 'POWERTRAIN', name: 'Powertrain & ePT',
    subdomains: ['IC Engines', 'Transmission', 'Electric Drive', 'Calibration'],
    roles: [
      { code: 'ENGINE_ENG', name: 'Engine Design Engineer', skills: ['IC Engine Design', 'Combustion', 'GT-Power', 'GD&T'] },
      { code: 'TRANS_ENG', name: 'Transmission Engineer', skills: ['Gear Design', 'Transmission Calibration', 'Vehicle Dynamics'] },
      { code: 'EDRIVE_ENG', name: 'Electric Drive Engineer', skills: ['Electric Motor Design', 'Inverter Design', 'Motor Control', 'MATLAB Simulink'] },
      { code: 'CALIB_ENG', name: 'Powertrain Calibration Engineer', skills: ['ECU Calibration', 'Emission Compliance', 'INCA', 'MATLAB Simulink'] }
    ]
  },
  {
    code: 'EV_BATTERY', name: 'EV & Battery Technology',
    subdomains: ['Cell & Chemistry', 'Battery Pack', 'BMS', 'Charging'],
    roles: [
      { code: 'BMS_ENG', name: 'BMS Engineer', skills: ['Battery Management Systems', 'State Estimation', 'CAN', 'MATLAB Simulink'] },
      { code: 'CELL_ENG', name: 'Cell Engineer', skills: ['Lithium-ion Cells', 'Cell Testing', 'Electrochemistry'] },
      { code: 'PACK_ENG', name: 'Battery Pack Engineer', skills: ['Battery Pack Design', 'Thermal Management', 'Structural Design'] },
      { code: 'CHARGING_ENG', name: 'Charging Systems Engineer', skills: ['Charging Protocols', 'CCS2', 'Power Electronics', 'CAN'] }
    ]
  },
  {
    code: 'EMBEDDED', name: 'Embedded Systems & Software',
    subdomains: ['AUTOSAR', 'ECU Software', 'Infotainment', 'Functional Safety'],
    roles: [
      { code: 'AUTOSAR_ENG', name: 'AUTOSAR Software Engineer', skills: ['AUTOSAR', 'Embedded C', 'CAN', 'ISO 26262', 'Vector CANoe'] },
      { code: 'ECU_SW_ENG', name: 'ECU Software Engineer', skills: ['Embedded C', 'RTOS', 'CAN', 'UDS Diagnostics', 'MATLAB Simulink'] },
      { code: 'INFOTAINMENT_ENG', name: 'Infotainment Engineer', skills: ['Android Automotive', 'Qt', 'C++', 'HMI Design'] },
      { code: 'FUSA_ENG', name: 'Functional Safety Engineer', skills: ['ISO 26262', 'FMEA', 'HARA', 'Safety Case'] }
    ]
  },
  {
    code: 'ADAS', name: 'ADAS & Autonomous',
    subdomains: ['Perception', 'Sensor Fusion', 'Planning & Control', 'Validation'],
    roles: [
      { code: 'PERCEPTION_ENG', name: 'Perception Engineer', skills: ['Computer Vision', 'Deep Learning', 'Python', 'PyTorch', 'LiDAR'] },
      { code: 'FUSION_ENG', name: 'Sensor Fusion Engineer', skills: ['Sensor Fusion', 'Kalman Filtering', 'C++', 'Radar'] },
      { code: 'PLANNING_ENG', name: 'Planning & Control Engineer', skills: ['Motion Planning', 'Control Systems', 'Python', 'ROS'] },
      { code: 'ADAS_VAL_ENG', name: 'ADAS Validation Engineer', skills: ['HIL Testing', 'Scenario Testing', 'Vector CANoe', 'Python'] }
    ]
  },
  {
    code: 'MANUFACTURING', name: 'Manufacturing & Production',
    subdomains: ['Assembly', 'Welding & Stamping', 'Paint Shop', 'Industrial Engineering'],
    roles: [
      { code: 'PROD_ENG', name: 'Production Engineer', skills: ['Assembly Line Planning', 'Lean Manufacturing', 'Time Study'] },
      { code: 'WELD_ENG', name: 'Welding Engineer', skills: ['Weld Planning', 'Robotic Welding', 'Weld Inspection'] },
      { code: 'PAINT_ENG', name: 'Paint Process Engineer', skills: ['Paint Processes', 'Surface Treatment', 'Process Capability'] },
      { code: 'IND_ENG', name: 'Industrial Engineer', skills: ['Lean Manufacturing', 'Time Study', 'Plant Layout'] }
    ]
  },
  {
    code: 'QUALITY', name: 'Quality & Reliability',
    subdomains: ['Quality Systems', 'Supplier Quality', 'Reliability', 'Metrology'],
    roles: [
      { code: 'QUAL_ENG', name: 'Quality Engineer', skills: ['APQP', 'PPAP', 'FMEA', '8D Problem Solving', 'IATF 16949'] },
      { code: 'SUPPLIER_QUAL', name: 'Supplier Quality Engineer', skills: ['PPAP', 'Supplier Audits', '8D Problem Solving', 'Minitab'] },
      { code: 'RELIABILITY_ENG', name: 'Reliability Engineer', skills: ['Reliability Testing', 'Weibull Analysis', 'Durability Testing', 'Minitab'] },
      { code: 'METROLOGY_ENG', name: 'Metrology Engineer', skills: ['CMM Programming', 'GD&T', 'Measurement Systems Analysis'] }
    ]
  },
  {
    code: 'SUPPLY_CHAIN', name: 'Supply Chain & Procurement',
    subdomains: ['Sourcing', 'Logistics', 'Planning', 'Supplier Development'],
    roles: [
      { code: 'BUYER', name: 'Sourcing Buyer', skills: ['Strategic Sourcing', 'Cost Negotiation', 'Supplier Audits', 'SAP MM'] },
      { code: 'LOGISTICS_ENG', name: 'Logistics Engineer', skills: ['Inbound Logistics', 'Milk Run Planning', 'SAP MM'] },
      { code: 'SC_PLANNER', name: 'Supply Chain Planner', skills: ['MRP', 'Demand Planning', 'SAP MM', 'Inventory Management'] },
      { code: 'SUPPLIER_DEV', name: 'Supplier Development Engineer', skills: ['Supplier Audits', 'APQP', 'Lean Manufacturing'] }
    ]
  },
  {
    code: 'TESTING', name: 'Testing & Validation',
    subdomains: ['Vehicle Testing', 'Component Testing', 'HIL / SIL', 'Homologation'],
    roles: [
      { code: 'TEST_ENG', name: 'Test Engineer', skills: ['Durability Testing', 'Data Acquisition', 'Vector CANoe', 'Python'] },
      { code: 'HIL_ENG', name: 'HIL Engineer', skills: ['HIL Testing', 'dSPACE', 'MATLAB Simulink', 'CAN'] },
      { code: 'CRASH_TEST_ENG', name: 'Crash Test Engineer', skills: ['Crash Simulation', 'Barrier Testing', 'Data Acquisition'] },
      { code: 'HOMOLOG_ENG', name: 'Homologation Engineer', skills: ['Homologation', 'Emission Compliance', 'Regulatory Compliance'] }
    ]
  },
  {
    code: 'AFTERSALES', name: 'After-Sales & Service',
    subdomains: ['Service Engineering', 'Warranty', 'Dealer Operations', 'Technical Training'],
    roles: [
      { code: 'SERVICE_ENG', name: 'Service Engineer', skills: ['Diagnostics', 'UDS Diagnostics', 'Warranty Analysis'] },
      { code: 'WARRANTY_ANALYST', name: 'Warranty Analyst', skills: ['Warranty Analysis', '8D Problem Solving', 'Minitab'] },
      { code: 'DEALER_OPS', name: 'Dealer Operations Manager', skills: ['Dealer Operations', 'Service Network Planning'] },
      { code: 'TECH_TRAINER', name: 'Technical Trainer', skills: ['Technical Training', 'Diagnostics'] }
    ]
  },
  {
    code: 'CONNECTED', name: 'Connected Vehicle & Telematics',
    subdomains: ['Telematics', 'OTA', 'Cloud Platform', 'Cybersecurity'],
    roles: [
      { code: 'TELEMATICS_ENG', name: 'Telematics Engineer', skills: ['Telematics', 'MQTT', 'Embedded C', 'CAN'] },
      { code: 'OTA_ENG', name: 'OTA Platform Engineer', skills: ['OTA Updates', 'Cloud Architecture', 'Python', 'AWS'] },
      { code: 'CONNECTED_SEC', name: 'Automotive Cybersecurity Engineer', skills: ['Cybersecurity', 'ISO 21434', 'Penetration Testing', 'SecOC'] },
      { code: 'DATA_ENG', name: 'Vehicle Data Engineer', skills: ['Data Pipelines', 'Python', 'SQL', 'AWS'] }
    ]
  },
  {
    code: 'COMMERCIAL', name: 'Business & Commercial',
    subdomains: ['Sales', 'Marketing', 'Finance', 'Program Management'],
    roles: [
      { code: 'PROGRAM_MGR', name: 'Program Manager', skills: ['Program Management', 'APQP', 'Stakeholder Management'] },
      { code: 'SALES_MGR', name: 'Automotive Sales Manager', skills: ['Fleet Sales', 'Key Account Management'] },
      { code: 'COST_ENG', name: 'Cost Engineer', skills: ['Should Costing', 'Cost Negotiation', 'Excel Modelling'] },
      { code: 'PLM_SPEC', name: 'PLM Specialist', skills: ['Teamcenter', 'BOM Management', 'Change Management'] }
    ]
  }
]

/* tools: code -> [name, domains] */
const TOOLS = [
  ['CATIA', 'Dassault CATIA V5/V6', ['VEH_ENG', 'POWERTRAIN']],
  ['NX', 'Siemens NX', ['VEH_ENG', 'MANUFACTURING']],
  ['CREO', 'PTC Creo', ['VEH_ENG']],
  ['SOLIDWORKS', 'SolidWorks', ['VEH_ENG', 'MANUFACTURING']],
  ['AUTOCAD', 'AutoCAD', ['VEH_ENG', 'MANUFACTURING']],
  ['HYPERMESH', 'Altair HyperMesh', ['VEH_ENG']],
  ['ANSYS', 'Ansys Mechanical / Fluent', ['VEH_ENG', 'POWERTRAIN']],
  ['LS_DYNA', 'LS-DYNA', ['VEH_ENG', 'TESTING']],
  ['ABAQUS', 'Abaqus', ['VEH_ENG']],
  ['STAR_CCM', 'Siemens STAR-CCM+', ['VEH_ENG', 'POWERTRAIN']],
  ['GT_POWER', 'Gamma GT-Power', ['POWERTRAIN']],
  ['MATLAB', 'MATLAB / Simulink', ['POWERTRAIN', 'EV_BATTERY', 'EMBEDDED', 'ADAS', 'TESTING']],
  ['INCA', 'ETAS INCA', ['POWERTRAIN']],
  ['CANOE', 'Vector CANoe / CANalyzer', ['EMBEDDED', 'ADAS', 'TESTING', 'CONNECTED']],
  ['CANAPE', 'Vector CANape', ['POWERTRAIN', 'TESTING']],
  ['DSPACE', 'dSPACE HIL', ['TESTING', 'ADAS']],
  ['LABVIEW', 'NI LabVIEW', ['TESTING']],
  ['PYTHON', 'Python', ['ADAS', 'CONNECTED', 'TESTING']],
  ['CPP', 'C / C++', ['EMBEDDED', 'ADAS', 'CONNECTED']],
  ['PYTORCH', 'PyTorch', ['ADAS']],
  ['TENSORFLOW', 'TensorFlow', ['ADAS']],
  ['OPENCV', 'OpenCV', ['ADAS']],
  ['ROS', 'ROS / ROS2', ['ADAS']],
  ['QT', 'Qt', ['EMBEDDED']],
  ['ANDROID_AUTO', 'Android Automotive OS', ['EMBEDDED']],
  ['SAP_MM', 'SAP MM / PP', ['SUPPLY_CHAIN']],
  ['MINITAB', 'Minitab', ['QUALITY', 'AFTERSALES']],
  ['TEAMCENTER', 'Siemens Teamcenter', ['COMMERCIAL', 'VEH_ENG']],
  ['WINDCHILL', 'PTC Windchill', ['COMMERCIAL']],
  ['JIRA', 'Jira', ['COMMERCIAL', 'EMBEDDED']],
  ['AWS', 'AWS', ['CONNECTED']],
  ['SQL', 'SQL', ['CONNECTED', 'COMMERCIAL']],
  ['EXCEL', 'Advanced Excel', ['COMMERCIAL', 'SUPPLY_CHAIN', 'QUALITY']],
  ['CMM', 'CMM (Zeiss / Hexagon)', ['QUALITY']]
]

/* standards & protocols */
const STANDARDS = [
  ['IATF_16949', 'IATF 16949', ['QUALITY']],
  ['ISO_26262', 'ISO 26262 (FuSa)', ['EMBEDDED']],
  ['ISO_21434', 'ISO 21434 (Cybersecurity)', ['CONNECTED']],
  ['ASPICE', 'Automotive SPICE', ['EMBEDDED', 'ADAS']],
  ['APQP', 'APQP', ['QUALITY', 'COMMERCIAL']],
  ['PPAP', 'PPAP', ['QUALITY', 'SUPPLY_CHAIN']],
  ['FMEA_STD', 'FMEA (AIAG-VDA)', ['QUALITY', 'EMBEDDED']],
  ['AUTOSAR_STD', 'AUTOSAR Classic/Adaptive', ['EMBEDDED']],
  ['ISO_15765', 'ISO 15765 (CAN)', ['EMBEDDED', 'CONNECTED']],
  ['UDS_STD', 'UDS (ISO 14229)', ['EMBEDDED', 'AFTERSALES']],
  ['CCS2_STD', 'CCS2 / CHAdeMO', ['EV_BATTERY']],
  ['ISO_11898', 'ISO 11898 (CAN bus)', ['EMBEDDED']],
  ['ISO_20653', 'ISO 20653 (IP rating)', ['VEH_ENG', 'EV_BATTERY']],
  ['AIS_156', 'AIS-156 (India EV)', ['EV_BATTERY']],
  ['CMVR', 'CMVR / AIS homologation', ['TESTING']],
  ['BS_VI', 'BS-VI emission norms', ['POWERTRAIN', 'TESTING']]
]

/* synonyms: term -> canonical skill code */
const SYNONYMS = [
  ['BIW Design', ['body in white', 'biw', 'body-in-white engineering']],
  ['Battery Management Systems', ['bms', 'battery management system', 'battery controller']],
  ['AUTOSAR', ['autosar classic', 'autosar adaptive', 'autosar architecture']],
  ['ISO 26262', ['iso26262', 'functional safety iso 26262', 'fusa']],
  ['Computer Vision', ['cv', 'machine vision', 'image processing']],
  ['Deep Learning', ['dl', 'neural networks', 'deep neural network']],
  ['Sensor Fusion', ['data fusion', 'multi sensor fusion', 'sensor fusion algorithms']],
  ['HIL Testing', ['hardware in the loop', 'hil', 'hardware-in-loop']],
  ['Vehicle Dynamics', ['ride and handling', 'vehicle handling']],
  ['NVH Testing', ['noise vibration harshness', 'nvh']],
  ['GD&T', ['gdt', 'geometric dimensioning and tolerancing', 'geometric tolerancing']],
  ['FEA', ['finite element analysis', 'fea analysis', 'structural simulation']],
  ['Lean Manufacturing', ['lean', 'toyota production system', 'tps']],
  ['8D Problem Solving', ['8d', 'eight disciplines', '8d methodology']],
  ['State Estimation', ['soc estimation', 'state of charge estimation', 'soh estimation']],
  ['Motion Planning', ['path planning', 'trajectory planning']],
  ['OTA Updates', ['over the air updates', 'ota', 'fota', 'sota']],
  ['Telematics', ['telematics control unit', 'tcu', 'connected car']],
  ['Cybersecurity', ['cyber security', 'infosec', 'security engineering']],
  ['Strategic Sourcing', ['sourcing', 'procurement', 'purchasing']],
  ['Should Costing', ['should cost', 'should-cost analysis', 'teardown costing']],
  ['Diagnostics', ['vehicle diagnostics', 'obd', 'diagnostic engineering']],
  ['Program Management', ['programme management', 'project management', 'npi management']],
  ['Plant Layout', ['factory layout', 'shop floor layout']],
  ['Electric Motor Design', ['motor design', 'e-motor design', 'traction motor']],
  ['Inverter Design', ['power electronics design', 'inverter engineering']],
  ['Combustion', ['combustion development', 'combustion analysis']],
  ['Homologation', ['type approval', 'homologation testing', 'certification']],
  ['Penetration Testing', ['pentest', 'pen testing', 'ethical hacking']],
  ['Data Pipelines', ['etl', 'data engineering', 'data pipeline development']]
]

/* role equivalences (lateral moves the matcher should credit) */
const ROLE_EQUIV = [
  ['BIW_ENG', 'CHASSIS_ENG', 0.55],
  ['CAE_ENG', 'RELIABILITY_ENG', 0.4],
  ['BMS_ENG', 'EDRIVE_ENG', 0.6],
  ['FUSA_ENG', 'CONNECTED_SEC', 0.45],
  ['QUAL_ENG', 'SUPPLIER_QUAL', 0.8],
  ['TEST_ENG', 'HIL_ENG', 0.7],
  ['ADAS_VAL_ENG', 'HIL_ENG', 0.75],
  ['PROD_ENG', 'IND_ENG', 0.7],
  ['BUYER', 'SUPPLIER_DEV', 0.5],
  ['ECU_SW_ENG', 'AUTOSAR_ENG', 0.85]
]

/* role progressions: from -> to */
const ROLE_PROGRESS = [
  ['ENTRY', 'MID'], ['MID', 'SENIOR'], ['SENIOR', 'LEAD'], ['LEAD', 'PRINCIPAL'], ['INTERN', 'ENTRY']
]

/* ------------------------------------------------------- build the graph */
const nodes = []
const edges = []
const synonyms = []
let nextId = 1
const idOf = new Map()

const addNode = (kind, code, name, parentId, extra = {}) => {
  const id = nextId++
  nodes.push({ id, kind, code, name, parentId, level: extra.level ?? null, relevance: extra.relevance ?? null, desc: extra.desc ?? null })
  idOf.set(`${kind}:${code}`, id)
  return id
}

const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`)

const industryId = addNode('industry', INDUSTRY.code, INDUSTRY.name, null, { desc: INDUSTRY.desc })

for (const [code, name, yrs] of LEVELS) addNode('experience_level', code, name, industryId, { level: yrs })

const domainIds = new Map()
const skillIds = new Map()

for (const d of DOMAINS) {
  const dId = addNode('domain', d.code, d.name, industryId)
  domainIds.set(d.code, dId)
  d.subdomains.forEach((sd, i) => addNode('subdomain', `${d.code}_SD${i + 1}`, sd, dId))

  for (const s of d.skills || []) {
    if (skillIds.has(s)) continue
    const sId = addNode('technical_skill', s.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), s, dId)
    skillIds.set(s, sId)
  }
  for (const r of d.roles) {
    const rId = addNode('job_role', r.code, r.name, dId)
    for (const s of r.skills) {
      if (!skillIds.has(s)) {
        const sId = addNode('technical_skill', s.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), s, dId)
        skillIds.set(s, sId)
      }
      edges.push([rId, skillIds.get(s), 'role_to_skill', 1.0])
    }
  }
}

for (const [code, name, domains] of TOOLS) {
  const tId = addNode('software_tool', code, name, industryId)
  for (const d of domains) edges.push([tId, domainIds.get(d), 'tool_to_domain', 1.0])
}

for (const [code, name, domains] of STANDARDS) {
  const sId = addNode('standard_protocol', code, name, industryId)
  for (const d of domains) edges.push([sId, domainIds.get(d), 'tool_to_domain', 1.0])
}

// skill -> tool associations so a mention of a tool credits the parent skill
const SKILL_TOOL = [
  ['BIW Design', 'CATIA'], ['GD&T', 'CATIA'], ['FEA', 'HYPERMESH'], ['FEA', 'ANSYS'],
  ['Crash Simulation', 'LS_DYNA'], ['CFD', 'STAR_CCM'], ['IC Engine Design', 'GT_POWER'],
  ['Motor Control', 'MATLAB'], ['State Estimation', 'MATLAB'], ['Control Systems', 'MATLAB'],
  ['Computer Vision', 'OPENCV'], ['Deep Learning', 'PYTORCH'], ['Deep Learning', 'TENSORFLOW'],
  ['Motion Planning', 'ROS'], ['Telematics', 'CAN'], ['HIL Testing', 'DSPACE'],
  ['HIL Testing', 'LABVIEW'], ['Durability Testing', 'LABVIEW'], ['Warranty Analysis', 'MINITAB'],
  ['Reliability Testing', 'MINITAB'], ['MRP', 'SAP_MM'], ['Inventory Management', 'SAP_MM'],
  ['BOM Management', 'TEAMCENTER'], ['Change Management', 'TEAMCENTER'], ['Change Management', 'WINDCHILL'],
  ['Data Pipelines', 'AWS'], ['OTA Updates', 'AWS'], ['CMM Programming', 'CMM'],
  ['Android Automotive', 'ANDROID_AUTO'], ['HMI Design', 'QT'], ['Should Costing', 'EXCEL'],
  ['Demand Planning', 'SAP_MM'], ['Penetration Testing', 'PYTHON']
]
for (const [skill, tool] of SKILL_TOOL) {
  const s = skillIds.get(skill)
  const t = idOf.get(`software_tool:${tool}`)
  if (s && t) edges.push([s, t, 'skill_to_tool', 1.0])
}

for (const [term, alts] of SYNONYMS) {
  const sid = skillIds.get(term) ||
    idOf.get(`standard_protocol:${term.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`)
  if (!sid) { console.warn('  ! synonym target missing:', term); continue }
  for (const a of alts) synonyms.push([sid, a])
}

for (const [a, b, w] of ROLE_EQUIV) {
  const ia = idOf.get(`job_role:${a}`), ib = idOf.get(`job_role:${b}`)
  if (ia && ib) edges.push([ia, ib, 'role_equivalent', w])
}

// experience-level progression edges
for (const [a, b] of ROLE_PROGRESS) {
  edges.push([idOf.get(`experience_level:${a}`), idOf.get(`experience_level:${b}`), 'role_progression', 1.0])
}

/* ------------------------------------------------------------ emit SQL */
const out = []
out.push('-- ============================================================================')
out.push('-- GENERATED FILE — do not edit by hand.')
out.push('-- Source: scripts/build-taxonomy.mjs   Regenerate: node scripts/build-taxonomy.mjs')
out.push('-- Automotive taxonomy v1 (N8): 1 industry, 12 domains, roles, skills, tools,')
out.push('-- standards, synonyms and weighted edges. Nothing here is AI-generated at runtime.')
out.push('-- ============================================================================')
out.push('')
out.push(`INSERT OR IGNORE INTO taxonomy_versions (id, version, status, notes, created_at, published_at)
VALUES (1, 1, 'active', 'Automotive taxonomy v1 — seeded, human-approved baseline', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z');`)
out.push('')

const chunk = (arr, n) => { const r = []; for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n)); return r }

for (const group of chunk(nodes, 40)) {
  out.push('INSERT OR IGNORE INTO taxonomy_nodes (id, version_id, kind, code, name, description, parent_id, level, relevance) VALUES')
  out.push(group.map((n) => `  (${n.id}, 1, ${q(n.kind)}, ${q(n.code)}, ${q(n.name)}, ${q(n.desc)}, ${n.parentId ?? 'NULL'}, ${n.level ?? 'NULL'}, ${q(n.relevance)})`).join(',\n') + ';')
  out.push('')
}

for (const group of chunk(synonyms, 40)) {
  out.push('INSERT OR IGNORE INTO taxonomy_synonyms (node_id, term) VALUES')
  out.push(group.map(([id, term]) => `  (${id}, ${q(term)})`).join(',\n') + ';')
  out.push('')
}

for (const group of chunk(edges, 40)) {
  out.push('INSERT OR IGNORE INTO taxonomy_edges (version_id, from_id, to_id, relation, weight) VALUES')
  out.push(group.map(([f, t, rel, w]) => `  (1, ${f}, ${t}, ${q(rel)}, ${w})`).join(',\n') + ';')
  out.push('')
}

writeFileSync(new URL('../migrations/0005_taxonomy_seed.sql', import.meta.url), out.join('\n'))
console.log(`taxonomy v1 → ${nodes.length} nodes, ${synonyms.length} synonyms, ${edges.length} edges`)
