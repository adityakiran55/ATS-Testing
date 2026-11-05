-- VSolutions ATS v2.0 — core recruiting entities
-- All timestamps are stored as UTC ISO-8601 (datetime('now') / strftime with Z).

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','recruiter','hiring_manager','interviewer','coordinator')),
  title         TEXT,
  department    TEXT,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ---------------------------------------------------------------- requisitions
CREATE TABLE IF NOT EXISTS jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  department       TEXT NOT NULL,
  location         TEXT NOT NULL,
  work_mode        TEXT NOT NULL DEFAULT 'onsite' CHECK (work_mode IN ('onsite','hybrid','remote')),
  employment_type  TEXT NOT NULL DEFAULT 'full_time' CHECK (employment_type IN ('full_time','contract','part_time','intern')),
  seniority        TEXT,
  description      TEXT NOT NULL DEFAULT '',
  requirements     TEXT NOT NULL DEFAULT '',
  must_have_skills TEXT NOT NULL DEFAULT '[]',
  nice_to_have     TEXT NOT NULL DEFAULT '[]',
  salary_min       INTEGER,
  salary_max       INTEGER,
  currency         TEXT NOT NULL DEFAULT 'USD',
  openings         INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','submitted','pending_approval','approved','open','paused','filled','cancelled','closed')),
  priority         TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  recruiter_id     INTEGER REFERENCES users(id),
  hiring_manager_id INTEGER REFERENCES users(id),
  created_by       INTEGER NOT NULL REFERENCES users(id),
  target_fill_date TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  submitted_at     TEXT,
  approved_at      TEXT,
  opened_at        TEXT,
  filled_at        TEXT,
  closed_at        TEXT,
  close_reason     TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_hm ON jobs(hiring_manager_id);
CREATE INDEX IF NOT EXISTS idx_jobs_recruiter ON jobs(recruiter_id);

CREATE TABLE IF NOT EXISTS job_approvals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES jobs(id),
  step       INTEGER NOT NULL,
  actor_id   INTEGER NOT NULL REFERENCES users(id),
  decision   TEXT NOT NULL CHECK (decision IN ('approved','rejected','changes_requested')),
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ------------------------------------------------------------------ candidates
CREATE TABLE IF NOT EXISTS candidates (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name         TEXT NOT NULL,
  last_name          TEXT NOT NULL,
  email              TEXT NOT NULL,
  phone              TEXT,
  location           TEXT,
  country            TEXT,
  headline           TEXT,
  current_employer   TEXT,
  education          TEXT,
  experience_years   REAL,
  notice_period_days INTEGER,
  current_salary     INTEGER,
  expected_salary    INTEGER,
  salary_currency    TEXT DEFAULT 'USD',
  availability       TEXT,
  summary            TEXT,
  linkedin           TEXT,
  source             TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','archived','anonymized')),
  merged_into_id     INTEGER REFERENCES candidates(id),
  consent_status     TEXT NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('opt_in','opt_out','unknown')),
  retention_until    TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cand_email ON candidates(lower(email));
CREATE INDEX IF NOT EXISTS idx_cand_phone ON candidates(phone);
CREATE INDEX IF NOT EXISTS idx_cand_name ON candidates(lower(last_name), lower(first_name));
CREATE INDEX IF NOT EXISTS idx_cand_status ON candidates(status);

-- Denormalised, indexable search surface (ATS-01 / ATS-13)
CREATE TABLE IF NOT EXISTS candidate_index (
  candidate_id   INTEGER PRIMARY KEY REFERENCES candidates(id),
  search_blob    TEXT NOT NULL DEFAULT '',
  skills         TEXT NOT NULL DEFAULT '',
  titles         TEXT NOT NULL DEFAULT '',
  employers      TEXT NOT NULL DEFAULT '',
  education      TEXT NOT NULL DEFAULT '',
  locations      TEXT NOT NULL DEFAULT '',
  resume_text    TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cidx_blob ON candidate_index(search_blob);

CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT 'slate'
);

CREATE TABLE IF NOT EXISTS candidate_tags (
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  tag_id       INTEGER NOT NULL REFERENCES tags(id),
  tagged_by    INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (candidate_id, tag_id)
);

CREATE TABLE IF NOT EXISTS candidate_notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  application_id INTEGER,
  author_id    INTEGER NOT NULL REFERENCES users(id),
  body         TEXT NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('team','private')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS candidate_consent (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  channel      TEXT NOT NULL CHECK (channel IN ('email','sms','phone','whatsapp')),
  status       TEXT NOT NULL CHECK (status IN ('opt_in','opt_out','unknown')),
  source       TEXT,
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (candidate_id, channel)
);

CREATE TABLE IF NOT EXISTS data_subject_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  type         TEXT NOT NULL CHECK (type IN ('export','delete','retention_review')),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','rejected')),
  note         TEXT,
  requested_by INTEGER REFERENCES users(id),
  completed_by INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  completed_at TEXT
);

-- ------------------------------------------------------------------- resumes
CREATE TABLE IF NOT EXISTS resumes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id  INTEGER NOT NULL REFERENCES candidates(id),
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'application/pdf',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  raw_text      TEXT,
  parsed_json   TEXT NOT NULL DEFAULT '{}',
  parse_confidence REAL,
  status        TEXT NOT NULL DEFAULT 'uploaded'
                CHECK (status IN ('uploaded','malware_scan','queued','parsing','parsed','screening_ready','failed','dead_letter')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  is_primary    INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_resume_status ON resumes(status);

CREATE TABLE IF NOT EXISTS resume_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_id    INTEGER NOT NULL REFERENCES resumes(id),
  state        TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','done','failed','dead_letter')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_run_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_error   TEXT,
  event_key    TEXT UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- -------------------------------------------------------------- applications
CREATE TABLE IF NOT EXISTS applications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id    INTEGER NOT NULL REFERENCES candidates(id),
  job_id          INTEGER NOT NULL REFERENCES jobs(id),
  stage           TEXT NOT NULL DEFAULT 'applied'
                  CHECK (stage IN ('applied','parsing','screening','recruiter_review','manager_review','interview','offer','hired')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','rejected','withdrawn','hired')),
  source          TEXT,
  source_detail   TEXT,
  recruiter_id    INTEGER REFERENCES users(id),
  match_score     REAL,
  rejection_reason TEXT,
  drop_off_reason TEXT,
  stage_entered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  applied_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  first_review_at TEXT,
  decision_at     TEXT,
  closed_at       TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (candidate_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_app_stage ON applications(stage, status);
CREATE INDEX IF NOT EXISTS idx_app_job ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_app_cand ON applications(candidate_id);

CREATE TABLE IF NOT EXISTS application_stage_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  from_stage     TEXT,
  to_stage       TEXT NOT NULL,
  from_status    TEXT,
  to_status      TEXT,
  actor_id       INTEGER REFERENCES users(id),
  reason         TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ash_app ON application_stage_history(application_id);

-- ----------------------------------------------------------------- interviews
CREATE TABLE IF NOT EXISTS interviews (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  round          INTEGER NOT NULL DEFAULT 1,
  title          TEXT NOT NULL DEFAULT 'Interview',
  mode           TEXT NOT NULL DEFAULT 'video' CHECK (mode IN ('video','phone','onsite')),
  scheduled_at   TEXT,
  duration_min   INTEGER NOT NULL DEFAULT 45,
  location       TEXT,
  meeting_link   TEXT,
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','scheduled','confirmed','completed','feedback_pending','feedback_complete','decision','cancelled')),
  feedback_due_at TEXT,
  completed_at   TEXT,
  cancelled_reason TEXT,
  scorecard_template_id INTEGER,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_int_app ON interviews(application_id);
CREATE INDEX IF NOT EXISTS idx_int_status ON interviews(status);

CREATE TABLE IF NOT EXISTS interview_participants (
  interview_id INTEGER NOT NULL REFERENCES interviews(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  role         TEXT NOT NULL DEFAULT 'interviewer' CHECK (role IN ('lead','interviewer','shadow')),
  PRIMARY KEY (interview_id, user_id)
);

CREATE TABLE IF NOT EXISTS scorecard_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  job_id     INTEGER REFERENCES jobs(id),
  stage      TEXT,
  criteria   TEXT NOT NULL DEFAULT '[]',
  required   INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id   INTEGER NOT NULL REFERENCES interviews(id),
  interviewer_id INTEGER NOT NULL REFERENCES users(id),
  scores_json    TEXT NOT NULL DEFAULT '[]',
  overall        INTEGER,
  recommendation TEXT CHECK (recommendation IN ('strong_yes','yes','no','strong_no','mixed')),
  evidence       TEXT,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  version        INTEGER NOT NULL DEFAULT 1,
  submitted_at   TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (interview_id, interviewer_id)
);

-- --------------------------------------------------------------------- offers
CREATE TABLE IF NOT EXISTS offers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  version        INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','approval_pending','approved','released','accepted','declined','expired','withdrawn')),
  base_salary    INTEGER,
  bonus          INTEGER,
  equity         TEXT,
  currency       TEXT NOT NULL DEFAULT 'USD',
  start_date     TEXT,
  expires_at     TEXT,
  notes          TEXT,
  approval_note  TEXT,
  approved_by    INTEGER REFERENCES users(id),
  approved_at    TEXT,
  released_at    TEXT,
  responded_at   TEXT,
  response_note  TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (application_id, version)
);

-- --------------------------------------------------------------- onboarding
CREATE TABLE IF NOT EXISTS onboarding (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL UNIQUE REFERENCES applications(id),
  status         TEXT NOT NULL DEFAULT 'not_started'
                 CHECK (status IN ('not_started','initiated','pending_documents','ready_to_join','joined','no_show','cancelled')),
  tasks_json     TEXT NOT NULL DEFAULT '[]',
  start_date     TEXT,
  initiated_at   TEXT,
  ready_at       TEXT,
  joined_at      TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
