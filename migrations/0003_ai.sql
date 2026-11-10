-- ============================================================================
-- VSolutions ATS — AI Integration & Multi-LLM Provider Management
-- Part 11 of the specification (A–L). Additive only: nothing here alters
-- existing ATS tables, so all current functionality is preserved.
-- ============================================================================

-- ---------------------------------------------------------------- providers
CREATE TABLE IF NOT EXISTS ai_providers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  logo              TEXT,
  base_url          TEXT NOT NULL,
  -- Secrets: AES-GCM ciphertext + IV, base64. NEVER selected into a response.
  api_key_enc       TEXT,
  api_key_iv        TEXT,
  api_key_hint      TEXT,            -- last 4 chars only, for UI display
  org_id            TEXT,
  enabled           INTEGER NOT NULL DEFAULT 0,
  local_only        INTEGER NOT NULL DEFAULT 0,
  default_model     TEXT,
  status            TEXT NOT NULL DEFAULT 'not_configured'
                    CHECK (status IN ('connected','error','not_configured','disabled')),
  last_check_at     TEXT,
  last_error        TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 100,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ------------------------------------------------------------------- models
CREATE TABLE IF NOT EXISTS ai_models (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id     INTEGER NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_id        TEXT NOT NULL,
  name            TEXT NOT NULL,
  context_window  INTEGER,
  input_price     REAL,              -- USD per 1M input tokens
  output_price    REAL,              -- USD per 1M output tokens
  vision          INTEGER NOT NULL DEFAULT 0,
  tools           INTEGER NOT NULL DEFAULT 0,
  streaming       INTEGER NOT NULL DEFAULT 1,
  availability    TEXT NOT NULL DEFAULT 'available'
                  CHECK (availability IN ('available','unavailable','unknown')),
  source          TEXT NOT NULL DEFAULT 'discovered'
                  CHECK (source IN ('discovered','custom','seed')),
  discovered_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (provider_id, model_id)
);

-- ------------------------------------------------- feature → provider routing
CREATE TABLE IF NOT EXISTS ai_feature_config (
  feature              TEXT PRIMARY KEY,
  provider_id          INTEGER REFERENCES ai_providers(id) ON DELETE SET NULL,
  model_id             TEXT,
  fallback_provider_id INTEGER REFERENCES ai_providers(id) ON DELETE SET NULL,
  fallback_model_id    TEXT,
  temperature          REAL NOT NULL DEFAULT 0.3,
  max_tokens           INTEGER NOT NULL DEFAULT 1200,
  enabled              INTEGER NOT NULL DEFAULT 1,
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- --------------------------------------------------------- request accounting
CREATE TABLE IF NOT EXISTS ai_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_slug  TEXT NOT NULL,
  model_id       TEXT,
  feature        TEXT NOT NULL,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  latency_ms     INTEGER NOT NULL DEFAULT 0,
  attempt        INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL CHECK (status IN ('success','error','fallback','blocked')),
  error_code     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ------------------------------------------------------ limits / alerts / settings
CREATE TABLE IF NOT EXISTS ai_usage_limits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scope         TEXT NOT NULL CHECK (scope IN ('global','provider','feature','user')),
  scope_ref     TEXT,
  period        TEXT NOT NULL CHECK (period IN ('day','week','month')),
  limit_tokens  INTEGER,
  limit_cost    REAL,
  alert_at_pct  INTEGER NOT NULL DEFAULT 80,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS ai_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ---------------------------------------------------------------- ai audit log
CREATE TABLE IF NOT EXISTS ai_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT NOT NULL DEFAULT '{}',   -- secrets already redacted
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_requests_created ON ai_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_requests_feature ON ai_requests(feature);
CREATE INDEX IF NOT EXISTS idx_ai_requests_provider ON ai_requests(provider_slug);
CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models(provider_id);
CREATE INDEX IF NOT EXISTS idx_ai_audit_created ON ai_audit(created_at);

-- --------------------------------------------------------------- seed providers
-- base_url values are the providers' documented public API roots.
INSERT OR IGNORE INTO ai_providers (slug, name, logo, base_url, sort_order) VALUES
  ('openai',     'OpenAI — ChatGPT',      'fa-solid fa-comment-dots', 'https://api.openai.com/v1',                    10),
  ('anthropic',  'Anthropic — Claude',    'fa-solid fa-feather',      'https://api.anthropic.com/v1',                 20),
  ('xai',        'xAI — Grok',            'fa-solid fa-bolt',         'https://api.x.ai/v1',                          30),
  ('deepseek',   'DeepSeek',              'fa-solid fa-water',        'https://api.deepseek.com/v1',                  40),
  ('ollama',     'Ollama (local)',        'fa-solid fa-server',       'http://localhost:11434',                       50),
  ('google',     'Google — Gemini',       'fa-solid fa-gem',          'https://generativelanguage.googleapis.com/v1beta', 60),
  ('azure',      'Azure OpenAI',          'fa-brands fa-microsoft',   'https://YOUR-RESOURCE.openai.azure.com/openai', 70),
  ('mistral',    'Mistral AI',            'fa-solid fa-wind',         'https://api.mistral.ai/v1',                    80),
  ('groq',       'Groq',                  'fa-solid fa-gauge-high',   'https://api.groq.com/openai/v1',               90),
  ('perplexity', 'Perplexity AI',         'fa-solid fa-magnifying-glass-chart', 'https://api.perplexity.ai',          100),
  ('openrouter', 'OpenRouter',            'fa-solid fa-route',        'https://openrouter.ai/api/v1',                 110),
  ('cohere',     'Cohere',                'fa-solid fa-cubes',        'https://api.cohere.com/v1',                    120);

-- Ollama is local-only by definition: it must never be treated as an external call.
UPDATE ai_providers SET local_only = 1 WHERE slug = 'ollama';

-- ------------------------------------------------------ seed feature routing
INSERT OR IGNORE INTO ai_feature_config (feature, temperature, max_tokens) VALUES
  ('resume_screening',    0.2, 1400),
  ('resume_parsing',      0.0, 1600),
  ('job_description',     0.7, 1600),
  ('candidate_matching',  0.2, 1200),
  ('interview_questions', 0.6, 1400),
  ('email_assistant',     0.5, 1200),
  ('analytics_insight',   0.3, 1200),
  ('chat_assistant',      0.4, 1600);

-- --------------------------------------------------------------- seed settings
INSERT OR IGNORE INTO ai_settings (key, value) VALUES
  ('pii_policy', 'redact'),              -- block | redact | allow
  ('external_calls_enabled', '1'),
  ('request_log_retention_days', '90'),
  ('max_retries', '2'),
  ('request_timeout_ms', '45000'),
  ('encryption_salt', '');
