-- ============================================================================
-- VSolutions ATS v3.0 — Phases 1–7
-- Additive only. Existing behaviour is preserved: every new tenancy column
-- defaults to tenant 1, so pre-existing rows and queries keep working.
-- ============================================================================

-- ===================================================== Phase 1 — tenancy (N5/D10)
CREATE TABLE IF NOT EXISTS tenants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  region     TEXT NOT NULL DEFAULT 'IN' CHECK (region IN ('IN','EU','NYC','CO','OTHER')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  settings   TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

INSERT OR IGNORE INTO tenants (id, slug, name, region) VALUES (1, 'default', 'VSolutions (pilot tenant)', 'IN');

-- Tenancy columns. DEFAULT 1 keeps every existing row valid.
ALTER TABLE users        ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE candidates   ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs         ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE applications ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE resumes      ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_candidates_tenant ON candidates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_applications_tenant ON applications(tenant_id);

-- Configurable RBAC (Phase 1: roles are data, not a hardcoded enum)
CREATE TABLE IF NOT EXISTS role_definitions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL DEFAULT 1,
  key         TEXT NOT NULL,
  label       TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (tenant_id, key)
);

INSERT OR IGNORE INTO role_definitions (tenant_id, key, label, is_system) VALUES
  (1, 'super_admin',        'Super Admin',         1),
  (1, 'tenant_admin',       'Tenant Admin',        1),
  (1, 'recruitment_manager','Recruitment Manager', 1),
  (1, 'recruiter',          'Recruiter',           1),
  (1, 'technical_reviewer', 'Technical Reviewer',  1),
  (1, 'client_user',        'Client User',         1),
  (1, 'read_only',          'Read-only',           1);

CREATE TABLE IF NOT EXISTS api_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL DEFAULT 1,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  last_used_at TEXT,
  expires_at  TEXT,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ==================================================== Phase 2 — taxonomy (N8)
CREATE TABLE IF NOT EXISTS taxonomy_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version     INTEGER NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','superseded','rolled_back')),
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS taxonomy_nodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id  INTEGER NOT NULL REFERENCES taxonomy_versions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN (
                'industry','domain','subdomain','job_role','specialization','competency',
                'technical_skill','software_tool','standard_protocol','experience_level')),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  parent_id   INTEGER REFERENCES taxonomy_nodes(id) ON DELETE SET NULL,
  level       INTEGER,
  relevance   TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (version_id, kind, code)
);

CREATE TABLE IF NOT EXISTS taxonomy_synonyms (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id   INTEGER NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
  term      TEXT NOT NULL,
  UNIQUE (node_id, term)
);

-- role_to_skill, skill_to_tool, tool_to_domain, skill_equivalence, role_to_equivalent
CREATE TABLE IF NOT EXISTS taxonomy_edges (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES taxonomy_versions(id) ON DELETE CASCADE,
  from_id   INTEGER NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
  to_id     INTEGER NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
  relation  TEXT NOT NULL CHECK (relation IN (
              'role_to_skill','skill_to_tool','tool_to_domain',
              'skill_equivalence','role_equivalent','role_progression')),
  weight    REAL NOT NULL DEFAULT 1.0,
  UNIQUE (version_id, from_id, to_id, relation)
);

-- AI may propose; nothing goes live without TX approval (N8)
CREATE TABLE IF NOT EXISTS taxonomy_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  term        TEXT NOT NULL,
  normalized  TEXT NOT NULL,
  kind        TEXT,
  context     TEXT,
  source      TEXT NOT NULL DEFAULT 'resume',
  occurrences INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','merged')),
  proposed_by INTEGER REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT,
  node_id     INTEGER REFERENCES taxonomy_nodes(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (normalized, source)
);

CREATE INDEX IF NOT EXISTS idx_taxonomy_nodes_version ON taxonomy_nodes(version_id, kind);
CREATE INDEX IF NOT EXISTS idx_taxonomy_nodes_parent ON taxonomy_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_taxonomy_syn_node ON taxonomy_synonyms(node_id);
CREATE INDEX IF NOT EXISTS idx_taxonomy_edges_from ON taxonomy_edges(from_id);

-- ============================================== Phase 3 — evidence spans (N1)
-- Every extracted item must point at a real span of the source document.
CREATE TABLE IF NOT EXISTS resume_fields (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      INTEGER NOT NULL DEFAULT 1,
  resume_id      INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  candidate_id   INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  field          TEXT NOT NULL,
  value          TEXT,
  confidence     REAL,
  evidence_text  TEXT,
  span_start     INTEGER,
  span_end       INTEGER,
  page_no        INTEGER,
  char_start     INTEGER,
  char_end       INTEGER,
  verified       INTEGER NOT NULL DEFAULT 0,
  needs_review   INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (resume_id, field)
);

CREATE TABLE IF NOT EXISTS resume_field_corrections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_id    INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  field        TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  corrected_by INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_resume_fields_resume ON resume_fields(resume_id);
CREATE INDEX IF NOT EXISTS idx_resume_fields_candidate ON resume_fields(candidate_id);

-- ==================================== Phase 4 — screening & ranking (N2, N7)
CREATE TABLE IF NOT EXISTS screening_profiles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 1,
  job_id          INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','superseded')),
  weights         TEXT NOT NULL DEFAULT '{}',
  knockouts       TEXT NOT NULL DEFAULT '{}',
  thresholds      TEXT NOT NULL DEFAULT '{}',
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (job_id, version)
);

CREATE TABLE IF NOT EXISTS screening_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      INTEGER NOT NULL DEFAULT 1,
  job_id         INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  candidate_id   INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  profile_id     INTEGER REFERENCES screening_profiles(id),
  class          TEXT NOT NULL CHECK (class IN (
                   'excellent','strong','good','partial','low','not_qualified','manual_review')),
  score          REAL,
  dimensions     TEXT NOT NULL DEFAULT '{}',
  knockouts_failed TEXT NOT NULL DEFAULT '[]',
  confidence     TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  summary        TEXT,
  status         TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('running','complete','failed','needs_review')),
  engine         TEXT NOT NULL DEFAULT 'taxonomy-hybrid-v1',
  prompt_version TEXT,
  model          TEXT,
  provider       TEXT,
  input_hash     TEXT,
  latency_ms     INTEGER,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- N1 enforced here: a claim without a verifiable span cannot be stored verified.
CREATE TABLE IF NOT EXISTS screening_evidence (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES screening_runs(id) ON DELETE CASCADE,
  dimension   TEXT NOT NULL,
  claim       TEXT NOT NULL,
  evidence    TEXT,
  resume_id   INTEGER REFERENCES resumes(id),
  char_start  INTEGER,
  char_end    INTEGER,
  page_no     INTEGER,
  verified    INTEGER NOT NULL DEFAULT 0,
  verify_note TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- N2 / human control: every override is recorded with a reason.
CREATE TABLE IF NOT EXISTS screening_overrides (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL REFERENCES screening_runs(id) ON DELETE CASCADE,
  reviewer_id     INTEGER NOT NULL REFERENCES users(id),
  original_class  TEXT NOT NULL,
  new_class       TEXT NOT NULL,
  reason          TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_screening_runs_job ON screening_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_screening_runs_candidate ON screening_runs(candidate_id);
CREATE INDEX IF NOT EXISTS idx_screening_evidence_run ON screening_evidence(run_id);

-- ================================================= Phase 5 — JD analysis
CREATE TABLE IF NOT EXISTS jd_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL DEFAULT 1,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  snapshot    TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded')),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (job_id, version)
);

CREATE TABLE IF NOT EXISTS jd_analyses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  issues     TEXT NOT NULL DEFAULT '[]',
  coverage   TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ============================================ Phase 6 — pipeline & notices
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL DEFAULT 1,
  key         TEXT NOT NULL,
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL,
  is_terminal INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, key)
);

INSERT OR IGNORE INTO pipeline_stages (tenant_id, key, label, sort_order, is_terminal) VALUES
  (1, 'new',                 'New',                 1,  0),
  (1, 'ai_screened',         'AI Screened',         2,  0),
  (1, 'shortlisted',         'Shortlisted',         3,  0),
  (1, 'recruiter_review',    'Recruiter Review',    4,  0),
  (1, 'submitted_to_client','Submitted to Client', 5,  0),
  (1, 'interview',           'Interview',           6,  0),
  (1, 'selected',            'Selected',            7,  0),
  (1, 'offer',               'Offer',               8,  0),
  (1, 'joined',              'Joined',              9,  1),
  (1, 'on_hold',             'On Hold',            10,  0),
  (1, 'rejected',            'Rejected',           11,  1),
  (1, 'withdrawn',           'Withdrawn',          12,  1);

-- Phase 6: every candidate entering AI screening must be notified.
CREATE TABLE IF NOT EXISTS candidate_notices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      INTEGER NOT NULL DEFAULT 1,
  candidate_id   INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  jurisdiction   TEXT NOT NULL DEFAULT 'IN',
  text           TEXT NOT NULL,
  channel        TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','email','sms')),
  shown_at       TEXT,
  acknowledged_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ============================== Phase 7 — compliance pack (bias, DPDP, breach)
-- Demographic data is stored separately and NEVER joined into scoring.
CREATE TABLE IF NOT EXISTS demographic_data (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL DEFAULT 1,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  group_key    TEXT NOT NULL,
  group_value  TEXT NOT NULL,
  voluntary    INTEGER NOT NULL DEFAULT 1,
  consent_ref  TEXT,
  captured_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (candidate_id, group_key)
);

CREATE TABLE IF NOT EXISTS adverse_impact_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL DEFAULT 1,
  job_id       INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  period_from  TEXT,
  period_to    TEXT,
  payload      TEXT NOT NULL DEFAULT '{}',
  generated_by INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS breach_incidents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL DEFAULT 1,
  ref          TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  detected_at  TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  description  TEXT,
  checklist    TEXT NOT NULL DEFAULT '[]',
  notified_at  TEXT,
  closed_at    TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS processors (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      INTEGER NOT NULL DEFAULT 1,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'processor' CHECK (role IN ('processor','sub_processor','controller')),
  data_categories TEXT NOT NULL DEFAULT '[]',
  location       TEXT,
  transfer_basis TEXT,
  dpa_signed     INTEGER NOT NULL DEFAULT 0,
  dpa_date       TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS region_config (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL DEFAULT 1,
  region      TEXT NOT NULL CHECK (region IN ('IN','EU','NYC','CO','OTHER')),
  enabled     INTEGER NOT NULL DEFAULT 0,
  requirements TEXT NOT NULL DEFAULT '[]',
  notice_text TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (tenant_id, region)
);

INSERT OR IGNORE INTO region_config (tenant_id, region, enabled, requirements) VALUES
  (1, 'IN',  1, '["DPDP consent capture","purpose limitation","retention timer","erasure workflow"]'),
  (1, 'EU',  0, '["AI Act Art.50 notice","human oversight log","decision log export"]'),
  (1, 'NYC', 0, '["LL144 bias audit export","candidate notice","impact ratio"]'),
  (1, 'CO',  0, '["Colorado AI Act notice","impact assessment"]');

-- Phase 7: retention timers and pre-deletion notice
CREATE TABLE IF NOT EXISTS retention_policies (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         INTEGER NOT NULL DEFAULT 1,
  entity            TEXT NOT NULL DEFAULT 'candidate',
  retention_months  INTEGER NOT NULL DEFAULT 24,
  pre_deletion_days INTEGER NOT NULL DEFAULT 2,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (tenant_id, entity)
);

INSERT OR IGNORE INTO retention_policies (tenant_id, entity, retention_months, pre_deletion_days)
  VALUES (1, 'candidate', 24, 2);

-- Phase 7: processor seeds for the AI providers actually integrated
INSERT OR IGNORE INTO processors (tenant_id, name, role, data_categories, location, dpa_signed) VALUES
  (1, 'Anthropic',  'processor', '["resume text","profile fields"]', 'US', 0),
  (1, 'OpenAI',     'processor', '["resume text","profile fields"]', 'US', 0),
  (1, 'Ollama (local)', 'processor', '["resume text","profile fields"]', 'on-premise', 0);
