-- ============================================================================
-- VSolutions ATS v3.0 — Phase 4–7 support columns and indexes
-- Additive only: every column has a default, so existing rows keep working and
-- no prior migration needs to be replayed.
-- ============================================================================

-- Phase 6: the 12-stage pipeline is data (pipeline_stages). Applications keep a
-- denormalised pointer so list screens stay single-query. Legacy `stage` remains
-- the source of truth for the v2.0 state machine; `pipeline_stage` is the v3.0
-- view that adds ai_screened / shortlisted / submitted_to_client / selected /
-- joined / on_hold / withdrawn.
ALTER TABLE applications ADD COLUMN pipeline_stage TEXT NOT NULL DEFAULT 'new';
CREATE INDEX IF NOT EXISTS idx_applications_pipeline_stage ON applications(pipeline_stage);

-- Phase 4: screening runs are advisory. A run may only become a decision after a
-- named human signs it off, which is recorded here (N2 / human control).
ALTER TABLE screening_runs ADD COLUMN decided_by INTEGER REFERENCES users(id);
ALTER TABLE screening_runs ADD COLUMN decided_at TEXT;
ALTER TABLE screening_runs ADD COLUMN decision TEXT;
ALTER TABLE screening_runs ADD COLUMN evidence_coverage REAL;
ALTER TABLE screening_runs ADD COLUMN input_kind TEXT NOT NULL DEFAULT 'resume';

-- Phase 4: an override must state whether it was a genuine human judgement or a
-- correction of a machine error; the two are audited differently.
ALTER TABLE screening_overrides ADD COLUMN override_kind TEXT NOT NULL DEFAULT 'human_judgement';

-- Phase 4: knock-out outcomes are stored per rule so the UI can explain exactly
-- which rule fired, with the evidence that fired it.
CREATE TABLE IF NOT EXISTS screening_knockouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES screening_runs(id) ON DELETE CASCADE,
  rule        TEXT NOT NULL,
  label       TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('pass','fail','unknown')),
  detail      TEXT,
  evidence    TEXT,
  char_start  INTEGER,
  char_end    INTEGER,
  verified    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_screening_knockouts_run ON screening_knockouts(run_id);

-- Phase 5: requirement extraction provenance — which requirement came from which
-- sentence of the JD, so an edited JD can be diffed requirement by requirement.
CREATE TABLE IF NOT EXISTS jd_requirements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL DEFAULT 1,
  jd_version_id INTEGER NOT NULL REFERENCES jd_versions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'must_have' CHECK (kind IN ('must_have','nice_to_have')),
  text         TEXT NOT NULL,
  node_id      INTEGER REFERENCES taxonomy_nodes(id),
  weight       REAL NOT NULL DEFAULT 1.0,
  evidence_text TEXT,
  char_start   INTEGER,
  char_end     INTEGER,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_jd_requirements_version ON jd_requirements(jd_version_id);

-- Phase 7: the human-oversight record required by EU AI Act Art.14-style review
-- and NYC LL144 audit exports. One row per screening decision reviewed by a human.
CREATE TABLE IF NOT EXISTS oversight_records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      INTEGER NOT NULL DEFAULT 1,
  run_id         INTEGER REFERENCES screening_runs(id) ON DELETE SET NULL,
  candidate_id   INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  reviewer_id    INTEGER NOT NULL REFERENCES users(id),
  review_kind    TEXT NOT NULL CHECK (review_kind IN ('accepted','overridden','rejected','escalated')),
  machine_class  TEXT,
  final_class    TEXT,
  reason         TEXT,
  reviewed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_oversight_run ON oversight_records(run_id);
CREATE INDEX IF NOT EXISTS idx_oversight_candidate ON oversight_records(candidate_id);

-- Phase 7: erasure is a workflow with states, not a delete. `data_subject_requests`
-- already tracks the request; this records each execution step for the audit pack.
CREATE TABLE IF NOT EXISTS erasure_steps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL DEFAULT 1,
  request_id   INTEGER REFERENCES data_subject_requests(id) ON DELETE CASCADE,
  candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
  step         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped','failed')),
  detail       TEXT,
  actor_id     INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_erasure_steps_request ON erasure_steps(request_id);

-- Phase 7: retention timer state, so the pre-deletion notice is provably sent
-- before anything is removed.
ALTER TABLE candidates ADD COLUMN deletion_notice_at TEXT;
ALTER TABLE candidates ADD COLUMN deletion_scheduled_at TEXT;
CREATE INDEX IF NOT EXISTS idx_candidates_retention ON candidates(retention_until);
