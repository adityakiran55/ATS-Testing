# VSolutions ATS — Applicant Tracking System v2.0

ATS-only recruiting platform covering requisition intake → sourcing → selection → offers → onboarding handoff,
with recruitment analytics. Built on **Hono + Cloudflare Workers/Pages + D1**.

**Repository**: https://github.com/adityakiran55/ATS-Testing (branch `main`)

## Status

| | |
|---|---|
| Build | ✅ `npm run build` (382 kB worker, 99 kB gzip) |
| Tests | ✅ `npm test` — **79/79 acceptance tests passing** |
| Pages | ✅ All 18 routes render 200 |
| Deployment | ⏸ **Awaiting user choice** between `cf-byok-deploy` (own Cloudflare account) and `gsk-hosted-deploy` (Genspark-managed) |

## Quick start

```bash
npm run db:reset      # migrate + seed local D1
npm run build
pm2 start ecosystem.config.cjs
npm test              # 79 acceptance tests
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
  pages/             dashboard, jobs, candidates, pipeline, interviews,
                     offers/onboarding/pools, analytics/comms/manager, ops, spec
migrations/          0001_core.sql (25 statements) · 0002_ops.sql
seed.sql             900 statements, 66 candidates, 70 applications, 8 requisitions
tests/api.test.mjs   79 acceptance tests
```

**39 tables** with foreign keys. Every state change writes `audit_events` with actor, timestamp,
previous value, new value and reason.

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

## Out of scope (per spec §7)

Payroll, employee HRMS lifecycle, vendor/agency CRM, campus administration, billing/subscriptions,
general HR, marketing/CMS. Onboarding exists only as the post-hire recruitment handoff.
