-- VSolutions ATS v2.0 — recruiting operations, automation, AI traceability

-- ------------------------------------------------------- job distribution (ATS-03)
CREATE TABLE IF NOT EXISTS channels (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL CHECK (type IN ('internal','job_board','aggregator','social')),
  api_supported  INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  field_mapping  TEXT NOT NULL DEFAULT '{}',
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS job_postings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES jobs(id),
  channel_id    INTEGER NOT NULL REFERENCES channels(id),
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','queued','published','failed','expired','withdrawn')),
  external_id   TEXT,
  external_url  TEXT,
  payload_json  TEXT NOT NULL DEFAULT '{}',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  posted_at     TEXT,
  expires_at    TEXT,
  withdrawn_at  TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (job_id, channel_id)
);

CREATE TABLE IF NOT EXISTS job_posting_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  posting_id INTEGER NOT NULL REFERENCES job_postings(id),
  action     TEXT NOT NULL,
  status     TEXT,
  detail     TEXT,
  actor_id   INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ------------------------------------------------ candidate communications (ATS-04)
CREATE TABLE IF NOT EXISTS message_templates (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  category  TEXT NOT NULL CHECK (category IN ('acknowledgement','screening','interview_invite','reschedule','rejection','offer','withdrawal','custom')),
  channel   TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms')),
  subject   TEXT NOT NULL,
  body      TEXT NOT NULL,
  active    INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id   INTEGER NOT NULL REFERENCES candidates(id),
  application_id INTEGER REFERENCES applications(id),
  template_id    INTEGER REFERENCES message_templates(id),
  batch_id       TEXT,
  channel        TEXT NOT NULL DEFAULT 'email',
  to_address     TEXT NOT NULL,
  subject        TEXT NOT NULL,
  body           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','bounced','skipped')),
  provider       TEXT,
  provider_message_id TEXT,
  error          TEXT,
  sent_at        TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_msg_cand ON messages(candidate_id);
CREATE INDEX IF NOT EXISTS idx_msg_status ON messages(status);

CREATE TABLE IF NOT EXISTS message_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  type       TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ---------------------------------------------------------- talent pools (ATS-08)
CREATE TABLE IF NOT EXISTS talent_pools (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  kind        TEXT NOT NULL DEFAULT 'pool' CHECK (kind IN ('pool','folder')),
  owner_id    INTEGER REFERENCES users(id),
  visibility  TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('team','private')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS talent_pool_members (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id           INTEGER NOT NULL REFERENCES talent_pools(id),
  candidate_id      INTEGER NOT NULL REFERENCES candidates(id),
  added_by          INTEGER REFERENCES users(id),
  source            TEXT,
  notes             TEXT,
  last_contact_at   TEXT,
  re_engagement     TEXT NOT NULL DEFAULT 'not_contacted'
                    CHECK (re_engagement IN ('not_contacted','contacted','interested','not_interested','hired')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (pool_id, candidate_id)
);

-- ------------------------------------------------------ saved searches (ATS-01)
CREATE TABLE IF NOT EXISTS saved_searches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,
  query      TEXT NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'boolean' CHECK (mode IN ('boolean','semantic')),
  filters    TEXT NOT NULL DEFAULT '{}',
  pool_id    INTEGER REFERENCES talent_pools(id),
  shared     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS search_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES users(id),
  query        TEXT,
  mode         TEXT,
  filters      TEXT,
  result_count INTEGER,
  duration_ms  INTEGER,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- --------------------------------------------- duplicates & merges (ATS-02)
CREATE TABLE IF NOT EXISTS duplicate_reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  primary_id   INTEGER NOT NULL REFERENCES candidates(id),
  duplicate_id INTEGER NOT NULL REFERENCES candidates(id),
  score        REAL NOT NULL,
  signals      TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','ignored')),
  decided_by   INTEGER REFERENCES users(id),
  decided_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (primary_id, duplicate_id)
);

CREATE TABLE IF NOT EXISTS candidate_merges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_id INTEGER NOT NULL REFERENCES candidates(id),
  merged_id    INTEGER NOT NULL REFERENCES candidates(id),
  snapshot     TEXT NOT NULL DEFAULT '{}',
  moved        TEXT NOT NULL DEFAULT '{}',
  actor_id     INTEGER NOT NULL REFERENCES users(id),
  reversible   INTEGER NOT NULL DEFAULT 1,
  reverted_at  TEXT,
  reverted_by  INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ------------------------------------------------------ automation rules (ATS-05)
CREATE TABLE IF NOT EXISTS automation_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT,
  trigger_event TEXT NOT NULL,
  conditions   TEXT NOT NULL DEFAULT '[]',
  actions      TEXT NOT NULL DEFAULT '[]',
  enabled      INTEGER NOT NULL DEFAULT 1,
  test_mode    INTEGER NOT NULL DEFAULT 0,
  run_count    INTEGER NOT NULL DEFAULT 0,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  last_run_at  TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id     INTEGER NOT NULL REFERENCES automation_rules(id),
  event_key   TEXT NOT NULL,
  event_name  TEXT NOT NULL,
  entity_ref  TEXT,
  status      TEXT NOT NULL CHECK (status IN ('success','failed','skipped','test')),
  detail      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (rule_id, event_key)
);

CREATE TABLE IF NOT EXISTS automation_event_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_name  TEXT NOT NULL,
  event_key   TEXT NOT NULL UNIQUE,
  payload     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ---------------------------------------------------------- tasks & SLA (ATS-06/07)
CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT NOT NULL DEFAULT 'review' CHECK (type IN ('review','feedback','approval','sla_alert','onboarding','custom')),
  title          TEXT NOT NULL,
  detail         TEXT,
  application_id INTEGER REFERENCES applications(id),
  job_id         INTEGER REFERENCES jobs(id),
  assignee_id    INTEGER REFERENCES users(id),
  due_at         TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','overdue','cancelled')),
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);

CREATE TABLE IF NOT EXISTS sla_settings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scope           TEXT NOT NULL DEFAULT 'stage' CHECK (scope IN ('stage','feedback','review','requisition')),
  stage           TEXT,
  threshold_hours INTEGER NOT NULL,
  escalate_to     TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (scope, stage)
);

-- ---------------------------------------------------------- audit & AI trace
CREATE TABLE IF NOT EXISTS audit_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  action        TEXT NOT NULL,
  actor_id      INTEGER REFERENCES users(id),
  previous_value TEXT,
  new_value     TEXT,
  reason        TEXT,
  meta          TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);

CREATE TABLE IF NOT EXISTS ai_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('match','summary','comparison','feedback_summary','semantic_search','insight')),
  entity_ref  TEXT NOT NULL,
  engine      TEXT NOT NULL,
  input_hash  TEXT,
  output      TEXT NOT NULL DEFAULT '{}',
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
