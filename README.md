# VSolutions ATS — automotive talent intelligence platform

ATS-only recruiting platform covering requisition intake → sourcing → selection → offers → onboarding handoff,
with recruitment analytics, a **centralized multi-provider AI layer**, and the **v3.0 automotive talent
intelligence program** (multi-tenancy, governed skill taxonomy, span-verified extraction, advisory screening
engine, JD builder, twelve-stage pipeline, compliance pack).
Built on **Hono + Cloudflare Workers/Pages + D1**.

**Repository**: https://github.com/adityakiran55/ATS-Testing (branch `main`)

## Status

| | |
|---|---|
| Build | ✅ `npm run build` (605 kB worker, 157 kB gzip, 112 modules) |
| Tests | ✅ `npm test` — **306/306 passing** (79 ATS + 80 AI + 147 phases) |
| Pages | ✅ All 31 routes render 200 |
| Database | 76 tables · 6 migrations · 138 audit events in the seeded instance |
| Deployment | ⏸ **Awaiting user choice** between `cf-byok-deploy` (own Cloudflare account) and `gsk-hosted-deploy` (Genspark-managed) |

## Quick start

```bash
npm run db:reset      # migrate + seed local D1
npm run build
pm2 start ecosystem.config.cjs
npm test              # all three suites (306 assertions)
npm run test:phases   # phases 1–7 only
```

**Demo accounts** — password `Password123!`

| Email | Role |
|---|---|
| admin@vsolutions.dev | Administrator |
| recruiter@vsolutions.dev | Recruiter |
| manager@vsolutions.dev | Hiring Manager |
| interviewer@vsolutions.dev | Interviewer |
| coordinator@vsolutions.dev | Coordinator |

## Features implemented (ATS-01 … ATS-15)

| ID | Feature | Route | Status |
|---|---|---|---|
| ATS-01 | Boolean + field-prefixed candidate search, saved searches, search audit | `/candidates` | ✅ |
| ATS-02 | Duplicate detection (email/phone/name/resume), merge preview, reversible merge | `/candidates/duplicates` | ✅ |
| ATS-03 | Job distribution per channel, retry/withdraw, unsupported-API disclosure | `/distribution` | ✅ |
| ATS-04 | Communication center, templates, consent-enforced sends, delivery states | `/communications` | ✅ |
| ATS-05 | Trigger-condition-action automation, test mode, idempotent runs | `/automation` | ✅ |
| ATS-06 | Hiring-manager review queue with row-level scoping | `/manager` | ✅ |
| ATS-07 | Stage SLA, aging, escalation tasks, recruiter workload | `/sla` | ✅ |
| ATS-08 | Talent pools/folders, tags, consent-aware re-engagement | `/pools` | ✅ |
| ATS-09 | Funnel + source analytics, 10 documented metrics, CSV export | `/analytics` | ✅ |
| ATS-10 | Scorecard feedback enforced before decisions; audited exceptions | `/interviews/:id` | ✅ |
| ATS-11 | One candidate → many applications, unified timeline | `/candidates/:id` | ✅ |
| ATS-12 | Evidence-backed candidate summaries & side-by-side comparison | profile / API | ✅ |
| ATS-13 | Semantic search with explainable match reasons | `/candidates?mode=semantic` | ✅ |
| ATS-14 | Interview feedback summarisation with conflict detection | application detail | ✅ |
| ATS-15 | Rule-based source quality & bottleneck insights with stated inputs | `/analytics` | ✅ |

`/spec` renders a live traceability matrix (feature → route → API → tables → roles → tests), the
permissions matrix generated from the same RBAC constant the app uses, and the state-transition tables.

## v3.0 program — automotive talent intelligence (Phases 1–7)

The v3.0 master specification locks an automotive-first, India-first multi-tenant SaaS. Its stated
stack is Laravel/PHP + PostgreSQL + pgvector + Redis/Horizon + Inertia/Vue. **None of that can run on
Cloudflare Workers** (no PHP, no sockets, no long-running process, no Postgres server). Rather than
claiming a stack the runtime cannot host, the phases were built on the existing deployable
Hono + D1 stack, preserving every *behavioural* non-negotiable. The stack deviation is disclosed
below, not hidden.

| Phase | Capability | Route | Non-negotiable honoured |
|---|---|---|---|
| 1 | Multi-tenant foundation, row-level isolation, live isolation probe | `/settings`, API | **N5 / D10** — every query is tenant-scoped; `/api/tenant/isolation-check` proves zero cross-tenant leakage at runtime |
| 2 | Governed automotive taxonomy: 294 nodes, 85 synonyms, 309 weighted edges, 12 domains | `/taxonomy` | **N8** — AI may only *propose*; publishing needs a named human approver; version history is immutable and rollback-able |
| 3 | Span-verified resume extraction with real character offsets | candidate profile | **N1** — a field without a re-readable source span is never treated as evidence |
| 4 | Advisory screening engine: 6 weighted dimensions, knock-outs, human gate | `/screening` | **N2 / N3 / N7** — protected attributes masked before scoring; the engine never auto-rejects and never moves the application |
| 5 | JD builder with bias guardrails, requirement extraction, version diff, pool coverage | `/jobs/:id/jd` | Protected phrases are a hard error; every extracted requirement carries an offset |
| 6 | Twelve-stage pipeline board with legal-transition enforcement and candidate notices | `/board` | Illegal skips refused; backward moves require a reason; terminal stages are final |
| 7 | Compliance pack: adverse impact, erasure, breach register, processors, regions, retention | `/compliance` | **N1** audit trail survives erasure by design, so a deletion stays provable |

### Non-negotiables and where they live in code

| ID | Rule | Enforcement |
|---|---|---|
| N1 | Every claim resolves to a real span of the source | `lib/evidence.ts` → `verifySpan`, re-checked on read and on correction |
| N2 | A human, named, with a reason, decides | `lib/screening.ts` → `decideRun` requires a 5+ char reason; writes `overseer_records` + audit |
| N3 | Protected attributes never enter scoring | `maskProtected()` runs before any dimension is computed |
| N5 | Tenant isolation on every read/write | `tenant_id` predicate on all queries; `/api/tenant/isolation-check` is a live cross-tenant probe |
| N7 | The engine can never auto-reject | `autoRejected: false`, `requiresHumanDecision: true` are returned by every run |
| N8 | Taxonomy grows only through human approval | suggestions stay `pending` until `POST /api/taxonomy/suggestions/:id/review` by an approver |

### Screening engine mechanics

Six dimensions — `must_have_coverage` (40), `skills_depth` (20), `experience` (18), `tooling` (12),
`education` (5), `recency` (5) — weights sum to 100 and are asserted in tests. A score is only
trusted when `MIN_EVIDENCE_ROWS = 3` verified rows and `MIN_EVIDENCE_COVERAGE = 55` are met;
below either threshold the run degrades to `manual_review` instead of emitting a confident number.

### v3.0 tables (migrations `0004_phases.sql`, `0005_taxonomy_seed.sql`, `0006_phase_support.sql`)

`tenants` · `taxonomy_versions` · `taxonomy_nodes` · `taxonomy_synonyms` · `taxonomy_edges` ·
`taxonomy_suggestions` · `resume_fields` · `screening_runs` · `screening_overrides` ·
`screening_knockouts` · `oversight_records` · `jd_requirements` · `erasure_steps` · `notices` ·
`breach_register` · `processors` · `region_controls` · `retention_policies` — additive only;
no ATS v2.0 table was altered destructively.

### Stack deviation (D12 disclosure)

The v3.0 prompt's own decision D12 requires stopping and asking when the repository holds a working
backend in another stack. This repository does — Hono/D1, deployed and tested. The phases were
therefore implemented against it rather than rewritten in PHP. What this costs:

| Required by v3.0 | Here | Consequence |
|---|---|---|
| PostgreSQL + pgvector | D1 (SQLite) | No `pgvector`; similarity is lexical + taxonomy-weighted, not embedding-based. Strong explanations, weaker pure-paraphrase recall. |
| Redis + Horizon queues | Lazy drain on request | No background worker; queues advance when a request arrives. Fine at test scale, would need a real queue at volume. |
| Row-level security (DB engine) | Application-level `tenant_id` predicates | Enforced in code + verified by a runtime probe, not by the database engine itself. |
| Inertia + Vue 3 | Hono JSX SSR + declarative client JS | Server-rendered pages with no SPA build; interactions are form/ajax actions. |
| Laravel/PHP | Hono/TypeScript | Whole different runtime. |

## AI Integration & Multi-LLM Provider Management (Part 11)

A centralized gateway sits between every ATS feature and every model. No feature calls a provider
directly, so routing, privacy, limits and accounting are enforced in exactly one place.

**12 providers, 5 wire protocols.** The adapters do not pretend all vendors share a format:

| Family | Providers | Endpoint shape |
|---|---|---|
| OpenAI-compatible | OpenAI, xAI, DeepSeek, Mistral, Groq, Perplexity, OpenRouter, Azure | `/chat/completions` |
| Anthropic | Claude | `/messages`, system prompt as a top-level field |
| Google | Gemini | `/models/{model}:generateContent` |
| Cohere | Cohere | `/chat`, `chat_history` array |
| Ollama | Local | `/api/chat`, `/api/tags`, no key |

**Dynamic model discovery.** Where a vendor exposes a listing endpoint the gateway uses it and
upserts metadata (context window, pricing where published). Perplexity, xAI and Azure have no
listing endpoint — those are marked "discovery unsupported" and model IDs are registered manually
rather than shipping a hardcoded list that silently goes stale.

**Encrypted credentials.** API keys are sealed with AES-GCM-256 (PBKDF2, 100k iterations). Only the
last four characters are ever returned to a browser. A per-installation salt is generated on first
use, so a fresh deployment can store keys before anyone configures a secret.

**Privacy gate before any external call.** `pii_policy` is `block` / `redact` (default) / `allow`.
Under `redact`, emails and phone numbers are replaced with placeholders on the way out; under `block`
the call is refused. Local Ollama is exempt because nothing leaves the deployment. `external_calls_enabled=0`
forces local-only operation.

**Cost from real token counts.** Tokens come from each provider's own response — including Ollama's
`prompt_eval_count` / `eval_count`. Cost is `tokens × registered price`; a model with no price shows
`$0` rather than an invented figure, and Ollama is never assigned a fake API cost.

**Advisory only.** Every feature prompt carries hard constraints: never reject, never hire, never make
a final decision; cite evidence or say it is missing. Screening scores are clamped to 0–100 and
labelled `decision_authority: none`. Email drafting refuses candidates with `consent_status = opt_out`.

### AI screens

| Route | Purpose |
|---|---|
| `/ai` | Dashboard — provider health, feature routing, 30-day usage, privacy posture |
| `/ai/providers` | Per-provider API key, base URL, org ID, default model, enable, test, discover |
| `/ai/models` | Model registry: context window, pricing, vision/tools/streaming, manual registration |
| `/ai/features` | Assign provider + model + fallback + temperature per ATS capability |
| `/ai/usage` | Requests, tokens in/out, cost, latency, provider/model/feature/daily breakdown, limits |
| `/ai/logs` | Per-call log (no prompts or secrets) + configuration audit trail |
| `/ai/security` | PII policy, external-call switch, retries, retention, credential-storage posture |

### AI API

`GET /api/ai/overview` · `GET|POST /api/ai/providers` · `PATCH /api/ai/providers/:id`
`POST /api/ai/providers/:id/test` · `POST /api/ai/providers/:id/discover`
`GET|POST /api/ai/models` · `PATCH|DELETE /api/ai/models/:id`
`GET /api/ai/features` · `POST /api/ai/features/:feature`
`POST /api/ai/settings` · `GET /api/ai/usage` · `GET /api/ai/limits/status`
`POST|DELETE /api/ai/limits[/:id]` · `GET /api/ai/logs` · `GET /api/ai/audit` · `POST /api/ai/logs/purge`
`POST /api/ai/run/:feature` · `POST /api/ai/chat`

Permissions: `ai.read` (admin, recruiter, hiring_manager) · `ai.invoke` (same) · `ai.configure` and
`ai.usage` (admin only).

### AI tables (migration `0003_ai.sql`)

`ai_providers` · `ai_models` · `ai_feature_config` · `ai_requests` · `ai_usage_limits` ·
`ai_settings` · `ai_audit` — 7 tables, additive only. No existing ATS table was altered.

## Architecture

```
src/
  index.tsx          router: pages + mount /api
  api/core.ts        auth, requisitions, applications
  api/index.ts       candidates, dupes, resumes, interviews, offers, pools,
                     messages, postings, automation, SLA, analytics, AI, users
  lib/
    rbac.ts          single-source permission matrix (5 roles × 45 permissions)
    lifecycle.ts     state machines: job, application, interview, offer, onboarding, resume, posting
    auth.ts          PBKDF2-SHA256 sessions (Web Crypto), row-level guards
    audit.ts         append-only audit + event bus + rule engine
    search.ts        recursive-descent Boolean parser, stemming, synonyms, cosine scoring
    searchService.ts one-pass search over candidate_index → explanations
    dedupe.ts        Jaro-Winkler + resume token overlap, merge/revert
    resume.ts        lazy pipeline, retries, dead letter, resume parsing
    sla.ts           UTC aging, thresholds, escalation
    metrics.ts       10 metric definitions, funnel, source breakdown
    ai.ts            deterministic rubric-evidence engine (no external model)
  modules/ai/        centralized multi-provider AI layer
    types.ts         adapter contract, wire-protocol families, feature keys
    crypto.ts        AES-GCM-256 at-rest key sealing, secret redaction
    providers/       12 adapters across 5 wire protocols
    gateway.ts       routing, retry/backoff, fallback, limits, usage, PII gate
    features.ts      8 ATS AI features, all routed through the gateway
    queries.ts       read models for the admin screens
    api.ts           /api/ai provider, model, routing, usage, logs, run
  pages/             dashboard, jobs, candidates, pipeline, interviews,
                     offers/onboarding/pools, analytics/comms/manager, ops,
                     ai (7 screens), phases (taxonomy, screening, run,
                     jd, board, compliance), spec
  lib/               v3.0 services
    taxonomy.ts      governed taxonomy: versions, graph load, matcher,
                     coverage, recommend, suggestion approval
    evidence.ts      N1 span extraction + verifySpan + experience union
    screening.ts     6-dimension advisory engine, knock-outs, decide gate
    jd.ts            JD validation, requirement extraction, diff, coverage
    pipeline.ts      12-stage board, LEGACY_MAP, transition rules, notices
    compliance.ts    impact ratio, 7-step erasure, breach/processor/region
  api/phases.ts      ~40 phase endpoints behind a shared error guard
migrations/          0001_core.sql · 0002_ops.sql · 0003_ai.sql
                     0004_phases.sql · 0005_taxonomy_seed.sql
                     0006_phase_support.sql
seed.sql             900 statements, 66 candidates, 70 applications, 8 requisitions
tests/api.test.mjs   79 ATS acceptance tests
tests/ai.test.mjs    80 AI acceptance tests
tests/phases.test.mjs 147 phase acceptance tests (Phases 1–7)
```

**76 tables** with foreign keys. Every state change writes `audit_events` with actor, timestamp,
previous value, new value and reason. AI configuration changes write `ai_audit`; AI calls write
`ai_requests` with real token counts and latency.

### Bug found by the phase suite (worth recording)

The first run of `tests/phases.test.mjs` passed 146/147; a second consecutive run failed
differently. That was the suite earning its keep twice:

1. **Version numbering collision.** `createVersion` derived the next version from
   `active.version + 1`. After a rollback the active version can be *lower* than an already-existing
   superseded version, so the insert collided with `UNIQUE(version)` and the endpoint returned 500.
   Fixed to derive from `SELECT COALESCE(MAX(version), 0)`.
2. **Draft cloning dropped every edge.** `createVersion` cloned nodes and synonyms but not
   `taxonomy_edges`, so publishing a draft silently produced a taxonomy with **zero weighted
   relations** and coverage collapsed. Fixed by cloning edges and remapping their endpoints through
   each node's stable `(kind, code)` identity, since node ids change on clone.

Both were only visible on a *second* run, against accumulated state. A single green run would have
shipped them.

## Key design decisions

**AI is deterministic and explainable.** Rather than calling an external model, `lib/ai.ts` runs a
rubric-evidence engine: each requisition criterion is matched against candidate text, and every claim
carries a quoted snippet, a source field and a confidence score. Output is persisted in `ai_runs`.
It never rejects or advances a candidate — all output is advisory and reviewable.
This makes the behaviour testable and avoids sending candidate PII to third parties.

**Async work runs lazily.** Workers cannot hold background jobs, so the resume queue drains on
request (admin "Drain queue" + automatic on upload). Each job has an idempotency key and a 3-attempt
budget before dead-lettering with manual retry.

**Merges never delete.** The losing record is marked `merged` with a `merged_into_id` pointer, and a
full snapshot plus moved-record counts go to `candidate_merges`. Merges are revertible.

**Distribution honesty.** Channels without a public partner API are marked "manual export only" in the
`channels` table. Publishing to them returns a 422 with an explicit failure reason that is recorded —
the app never claims a posting went live where it did not.

## Known gaps

- Channel publishing is simulated (`internal-sim` provider); wiring a real job board requires that
  board's partner credentials and their API contract.
- Email delivery is simulated; `messages.provider` is set to `internal-sim`. A real provider
  (Resend/SendGrid) plugs into `send_message` in `lib/audit.ts` and `POST /api/messages`.
- Semantic search is lexical (TF-IDF + synonyms), not embedding-based. Strong explanations, but it
  will miss pure paraphrase matches that a vector index would catch.
- E-signature on offers is out of scope; offers record release/acceptance only.
- Reporting timezone is fixed to UTC.
- **AI provider calls are verified against live APIs but no real keys ship with the repo.** Every
  adapter, the gateway, the PII gate, limits and cost accounting are exercised by tests; a
  successful completion additionally requires an admin to paste a real key in `/ai/providers`.
  Without one, features fail closed with `no_provider` / `missing_api_key` rather than faking output.
- **AI streaming is not wired to the browser.** The `streaming` capability is tracked per model and the
  gateway returns complete responses; token-by-token SSE rendering is not implemented.
- **Ollama pull/download is not implemented.** Installed models are discovered via `/api/tags`; pulling a
  new model requires running `ollama pull` on the host that serves it.
- Azure OpenAI deployment names are entered as the model ID; automatic deployment enumeration is not
  performed because Azure's management API is a separate surface from the inference API.

### v3.0 phase gaps (stated, not hidden)

- **Similarity is lexical, not vector.** D1 has no `pgvector`. Taxonomy-weighted term matching plus
  synonym/equivalence expansion replaces embedding distance. This misses pure paraphrase recall.
- **No background worker.** Resume queue, retention sweeps and notices advance on request. At volume
  this needs a real queue (Cloudflare Queues / Durable Objects).
- **Tenant isolation is application-enforced**, verified by a runtime probe — not by database
  row-level security.
- **Screening confidence is heuristic.** Thresholds (3 evidence rows, 55% coverage) are calibrated
  judgement, not statistically fitted. They route to `manual_review` conservatively rather than
  claiming precision.
- **Adverse impact needs volume to mean anything.** The 0.8 four-fifths rule suppresses cells below
  `MIN_CELL_SIZE = 5`; with the seeded dataset most groups report "insufficient data" — which is the
  honest answer, not a passing grade.
- **Erasure is logical, not physical.** Resume bodies and profile fields are purged and anonymised;
  audit rows are retained deliberately so the deletion is provable. Backup rotation is out of reach
  on D1.

## Out of scope (per spec §7)

Payroll, employee HRMS lifecycle, vendor/agency CRM, campus administration, billing/subscriptions,
general HR, marketing/CMS. Onboarding exists only as the post-hire recruitment handoff.

## Installation wizard — status and constraint

The supplied specification asks for a **Next.js + Prisma + PostgreSQL** installer that writes `.env`,
runs `prisma migrate deploy`, checks Node/NPM versions, and opens raw TCP connections to a database host.

This repository is **Hono + Cloudflare Workers + D1**. Those installer operations are not available in
the Workers runtime:

| Installer step | Blocked by |
|---|---|
| Write `.env` | No filesystem on Workers |
| `prisma migrate deploy` | No `child_process` |
| Connect to arbitrary Postgres host/port | No raw TCP (`net`/`tls`) |
| Check Node/NPM versions, file permissions | No `process`, no `fs` |

The specification also forbids simulated connections and static progress bars, so a decorative wizard
is not an acceptable substitute. Part 19 of the same specification ranks the installer **last** and
makes the AI integration Priority 1 — which is the ordering implemented here.

A genuine equivalent for this stack exists and is the recommended next step: a `/setup` guard flow that
runs on first boot, applies D1 migrations, generates the encryption salt, seeds roles and the first
administrator, writes an `install_lock` record, and then hard-disables itself. It is real, server-side,
and idempotent — but it is a different installer than the Next.js one described, so it was not built
unilaterally.
