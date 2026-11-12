import { Layout } from '../components/layout'
import { PageHead, Card, Badge, Stat } from '../components/ui'
import { titleCase } from '../lib/util'
import { PERMISSIONS, ADMIN_ONLY, ROLE_LABEL, type Role } from '../lib/rbac'
import type { AuthUser } from '../lib/auth'

type Feature = {
  id: string
  name: string
  priority: 'P1' | 'P2'
  phase: number
  routes: string
  apis: string
  tables: string
  roles: string
  tests: string
  status: 'complete' | 'partial'
  program?: string
  notes?: string
}

/**
 * Assertion counts per suite. Kept here so the spec page reports what the
 * suites actually contain rather than a number that drifts from reality.
 * Update these when a suite changes — they are the source of truth for
 * `npm test`.
 */
export const TEST_SUITE = { api: 79, ai: 80, phases: 147 }
export const TEST_TOTAL = TEST_SUITE.api + TEST_SUITE.ai + TEST_SUITE.phases

export const FEATURES: Feature[] = [
  {
    id: 'ATS-01', name: 'Advanced candidate search & rediscovery', priority: 'P1', phase: 1,
    routes: '/candidates, /candidates/:id',
    apis: 'GET /api/candidates, GET /api/candidates/export.csv, POST /api/saved-searches, DELETE /api/saved-searches/:id',
    tables: 'candidate_index, candidates, saved_searches, search_audit, tags, candidate_tags, talent_pool_members, applications',
    roles: 'admin, recruiter, hiring_manager (read), coordinator',
    tests: 'boolean AND/OR/NOT, phrase, field prefix, filters, sorting, saved search CRUD, search audit write',
    status: 'complete'
  },
  {
    id: 'ATS-02', name: 'Candidate duplicate detection & merge', priority: 'P1', phase: 1,
    routes: '/candidates/duplicates',
    apis: 'POST /api/candidates/duplicates/refresh, POST /api/candidates/duplicates/:id/ignore, POST /api/candidates/merge-preview, POST /api/candidates/merge, POST /api/merges/:id/revert',
    tables: 'duplicate_reviews, candidate_merges, candidates, applications, resumes, candidate_notes, messages, candidate_tags, talent_pool_members',
    roles: 'admin, recruiter (merge); revert = admin only',
    tests: 'signal scoring (email/phone/name/resume), preview counts, merge moves records, canonical id set, merge reversible, self-merge rejected',
    status: 'complete'
  },
  {
    id: 'ATS-03', name: 'Job posting & distribution management', priority: 'P1', phase: 2,
    routes: '/distribution, /jobs/:id',
    apis: 'POST /api/postings/:id/publish, POST /api/postings/:id/retry, POST /api/postings/:id/withdraw',
    tables: 'channels, job_postings, job_posting_events, jobs',
    roles: 'admin, recruiter, coordinator',
    tests: 'publish on supported channel, unsupported channel returns failure + records error, withdraw transition, requisition close auto-withdraws',
    status: 'complete',
    notes: 'Channels without a public partner API are explicitly marked “manual export only” and cannot be published.'
  },
  {
    id: 'ATS-04', name: 'Candidate communication center', priority: 'P1', phase: 2,
    routes: '/communications, /candidates/:id, /applications/:id',
    apis: 'POST /api/messages, GET /api/messages',
    tables: 'message_templates, messages, message_events, candidates',
    roles: 'admin, recruiter, coordinator',
    tests: 'template fill, opt-out blocked (422), custom body, delivery status recorded, timeline on profile',
    status: 'complete'
  },
  {
    id: 'ATS-05', name: 'Recruitment workflow automation', priority: 'P1', phase: 3,
    routes: '/automation',
    apis: 'POST /api/automation/rules, PATCH /api/automation/rules/:id, POST /api/automation/rules/:id/test',
    tables: 'automation_rules, automation_runs, automation_event_queue, tasks, messages',
    roles: 'admin (manage), recruiter (read)',
    tests: 'rule create/enable/disable, test mode produces no side effects, idempotent event keys, condition mismatch → skipped, execution log',
    status: 'complete'
  },
  {
    id: 'ATS-06', name: 'Hiring manager collaboration', priority: 'P1', phase: 2,
    routes: '/manager',
    apis: 'POST /api/applications/:id/review, POST /api/applications/:id/stage, POST /api/applications/:id/status',
    tables: 'jobs, applications, candidate_notes, interviews, feedback, tasks',
    roles: 'hiring_manager (own requisitions only)',
    tests: 'manager cannot act on unassigned requisition (403), shortlist/reject/request-info, decision history',
    status: 'complete'
  },
  {
    id: 'ATS-07', name: 'Recruiter SLA & stage aging', priority: 'P1', phase: 2,
    routes: '/sla, /settings',
    apis: 'POST /api/sla/escalate, PATCH /api/sla/settings/:stage',
    tables: 'sla_settings, applications, application_stage_history, tasks, jobs',
    roles: 'admin (manage), recruiter/hiring_manager/coordinator (read)',
    tests: 'threshold breach detection, escalation task idempotency, workload, requisition aging, UTC calculation',
    status: 'complete'
  },
  {
    id: 'ATS-08', name: 'Talent pools, folders, tags & re-engagement', priority: 'P1', phase: 2,
    routes: '/pools, /pools/:id',
    apis: 'POST /api/pools, PATCH /api/pools/:poolId/members/:candidateId, DELETE /api/pools/:poolId/members/:candidateId, POST /api/pools/reengage',
    tables: 'talent_pools, talent_pool_members, candidate_tags, tags, candidate_consent, messages',
    roles: 'admin, recruiter, coordinator',
    tests: 'pool create, membership add/remove, re-engagement status, consent-aware bulk outreach skips opt-outs',
    status: 'complete'
  },
  {
    id: 'ATS-09', name: 'Recruitment funnel & source analytics', priority: 'P1', phase: 3,
    routes: '/analytics, /',
    apis: 'GET /api/analytics, GET /api/analytics/export.csv',
    tables: 'applications, application_stage_history, interviews, offers, jobs, users',
    roles: 'admin, recruiter, hiring_manager',
    tests: 'funnel counts, all 10 metrics computed, denominators reported, filters applied consistently, CSV export matches display',
    status: 'complete'
  },
  {
    id: 'ATS-10', name: 'Interview feedback enforcement', priority: 'P1', phase: 1,
    routes: '/interviews, /interviews/:id',
    apis: 'POST /api/interviews, POST /api/interviews/:id/status, POST /api/interviews/:id/feedback, POST /api/interviews/:id/exception',
    tables: 'interviews, interview_participants, scorecard_templates, feedback, audit_events',
    roles: 'interviewer (submit), recruiter/hiring_manager (read), coordinator (schedule)',
    tests: 'scorecard criteria, evidence required, decision blocked while feedback outstanding, authorised exception recorded, panel aggregation',
    status: 'complete'
  },
  {
    id: 'ATS-11', name: 'Multiple applications & candidate history', priority: 'P1', phase: 1,
    routes: '/candidates/:id, /applications/:id, /pipeline',
    apis: 'POST /api/jobs/:id/applications, POST /api/applications/:id/stage',
    tables: 'candidates, applications, application_stage_history',
    roles: 'admin, recruiter, coordinator, hiring_manager',
    tests: 'one candidate → many applications, unique (candidate, job), independent stage/outcome, unified timeline',
    status: 'complete'
  },
  {
    id: 'ATS-12', name: 'AI candidate comparison & summaries', priority: 'P2', phase: 4,
    routes: '/candidates/:id (summary), application detail',
    apis: 'POST /api/ai/summary, POST /api/ai/compare',
    tables: 'ai_runs, candidate_index, candidates, jobs',
    roles: 'admin, recruiter, hiring_manager',
    tests: 'rubric evidence mapping, confidence reported, missing information listed, no auto-reject, ai_run persisted',
    status: 'complete',
    notes: 'Deterministic rubric-evidence engine — fully explainable, no external model call, output reviewable.'
  },
  {
    id: 'ATS-13', name: 'AI search & rediscovery (semantic)', priority: 'P2', phase: 4,
    routes: '/candidates (semantic mode)',
    apis: 'GET /api/candidates?mode=semantic, GET /api/ai/interpret',
    tables: 'candidate_index, search_audit',
    roles: 'admin, recruiter, hiring_manager, coordinator',
    tests: 'synonym expansion, stemming, match reasons shown, similarity threshold, plan explanation',
    status: 'complete'
  },
  {
    id: 'ATS-14', name: 'AI interview feedback summarization', priority: 'P2', phase: 4,
    routes: '/applications/:id, /interviews/:id',
    apis: 'POST /api/ai/feedback-summary, GET /api/interviews/:id/summary',
    tables: 'feedback, interviews, ai_runs',
    roles: 'admin, recruiter, hiring_manager, interviewer',
    tests: 'conflict detection, missing-evidence detection, source scorecards untouched, versioning preserved',
    status: 'complete'
  },
  {
    id: 'ATS-15', name: 'Source quality & bottleneck insights', priority: 'P2', phase: 4,
    routes: '/analytics',
    apis: 'GET /api/analytics (insights)',
    tables: 'applications, offers, jobs, sla_settings',
    roles: 'admin, recruiter, hiring_manager',
    tests: 'rule-based insights, transparent inputs listed, no unsupported predictions',
    status: 'complete'
  },

  /* ============================ v3.0 program — automotive talent intelligence */
  {
    id: 'V3-P1', name: 'Multi-tenant foundation & row-level isolation', priority: 'P1', phase: 1,
    program: 'v3.0',
    routes: '/settings (tenant), /compliance',
    apis: 'GET /api/tenant, GET /api/tenant/isolation-check',
    tables: 'tenants, users, candidates, jobs, applications, resumes, audit_events',
    roles: 'admin (isolation audit); every role is tenant-scoped on read',
    tests: 'tenant row present, region reported, isolation-check leaks zero rows across users/candidates/jobs/applications/resumes, non-admin gets 403',
    status: 'complete',
    notes: 'D10/N5 — every query filters by tenant_id. The isolation check is a live cross-tenant probe, not a static claim.'
  },
  {
    id: 'V3-P2', name: 'Governed automotive skill taxonomy', priority: 'P1', phase: 2,
    program: 'v3.0',
    routes: '/taxonomy',
    apis: 'GET /api/taxonomy, GET /api/taxonomy/nodes, GET/POST /api/taxonomy/suggestions, POST /api/taxonomy/suggestions/:id/review, POST /api/taxonomy/match, GET/POST/PUT /api/taxonomy/versions, POST /api/taxonomy/versions/:id/publish|rollback',
    tables: 'taxonomy_versions, taxonomy_nodes, taxonomy_synonyms, taxonomy_edges, taxonomy_suggestions',
    roles: 'admin (publish/rollback/approve); recruiter, hiring_manager, coordinator (read + suggest)',
    tests: '294 nodes / 309 weighted edges / 85 synonyms load, 12 domains, synonym + equivalence matching resolves, draft clones nodes AND edges, publish supersedes prior version, rollback restores, AI suggestion stays pending until a named human approves',
    status: 'complete',
    notes: 'N8 — AI may only propose; publishing requires an approved draft. Version cloning remaps edge endpoints by (kind, code) so a draft never loses its weighted relations.'
  },
  {
    id: 'V3-P3', name: 'Span-verified resume extraction', priority: 'P1', phase: 3,
    program: 'v3.0',
    routes: '/candidates/:id (fields), /screening/runs/:id',
    apis: 'GET/POST /api/resumes/:id/fields, POST /api/resumes/:id/extract, POST /api/resumes/:id/fields/:field, POST /api/evidence/preview',
    tables: 'resume_fields, resumes, candidates, audit_events',
    roles: 'admin, recruiter (extract + correct); coordinator read-only on corrections',
    tests: 'every persisted field carries a real char offset, verifySpan rejects out-of-bounds and mismatched claims, unverified values are parked not stored, correction requires a reason and re-verifies, explicit years beat summed intervals, overlapping intervals are unioned not summed',
    status: 'complete',
    notes: 'N1 — a claim that cannot be re-read from the source span is never treated as evidence.'
  },
  {
    id: 'V3-P4', name: 'Advisory screening engine with human decision gate', priority: 'P1', phase: 4,
    program: 'v3.0',
    routes: '/screening, /screening/runs/:id, /jobs/:id (screening profile)',
    apis: 'GET /api/screening/stats, GET /api/screening/queue, GET/PUT /api/jobs/:id/screening-profile, GET/POST /api/jobs/:id/screening/runs, GET /api/candidates/:id/screening, GET /api/screening/runs/:id, POST /api/screening/runs/:id/decide',
    tables: 'screening_runs, screening_overrides, screening_knockouts, oversight_records, applications, audit_events',
    roles: 'admin, recruiter (decide); hiring_manager read; coordinator read',
    tests: 'weights sum to 100, protected attributes rejected from scoring, engine never auto-rejects, engine never moves the application stage, decide requires a reason of 5+ chars, double decide returns 409, low coverage / thin evidence degrades to manual_review instead of a confident score',
    status: 'complete',
    notes: 'N2/N3/N7 — six weighted dimensions, protected-attribute masking before scoring, MIN_EVIDENCE_COVERAGE 55% and MIN_EVIDENCE_ROWS 3 before a class is trustworthy.'
  },
  {
    id: 'V3-P5', name: 'JD builder with bias guardrails', priority: 'P1', phase: 5,
    program: 'v3.0',
    routes: '/jobs/:id/jd',
    apis: 'GET /api/jobs/:id/jd, GET/POST /api/jobs/:id/jd/versions, GET /api/jd/versions/:id, POST /api/jd/diff, POST /api/jd/validate, POST /api/jd/extract, GET /api/jobs/:id/pool-coverage',
    tables: 'jd_requirements, jobs, taxonomy_nodes, applications, audit_events',
    roles: 'admin, recruiter (edit); hiring_manager (review); coordinator read',
    tests: 'protected phrases are an error not a warning, discouraged terms warn, vague phrasing advises, extracted requirements carry char offsets, version snapshot is immutable, diff reports added/removed, pool coverage previews against live candidates',
    status: 'complete'
  },
  {
    id: 'V3-P6', name: 'Twelve-stage pipeline board & notices', priority: 'P1', phase: 6,
    program: 'v3.0',
    routes: '/board, /pipeline',
    apis: 'GET /api/pipeline/board, GET /api/applications/:id/pipeline, POST /api/pipeline/backfill, GET /api/pipeline/mapping, GET/POST /api/candidates/:id/notices, POST /api/notices/:id/acknowledge',
    tables: 'applications, application_stage_history, notices, audit_events',
    roles: 'admin, recruiter, coordinator (move); hiring_manager (review stages)',
    tests: '12 columns rendered, backfill derives 62 of 77 legacy rows with 0 unassigned, illegal stage skips refused, backward moves require a reason, terminal stages refuse further moves, ai_screened raises a candidate notice',
    status: 'complete',
    notes: 'LEGACY_MAP keeps the original 10-state model readable while the board speaks the 12-stage language. derivePipelineStage is idempotent so backfill is safe to re-run.'
  },
  {
    id: 'V3-P7', name: 'Compliance pack — impact ratio, erasure, breach log', priority: 'P1', phase: 7,
    program: 'v3.0',
    routes: '/compliance',
    apis: 'GET /api/compliance/overview, GET/POST /api/compliance/adverse-impact, GET /api/compliance/adverse-impact.csv, GET /api/compliance/oversight, GET /api/compliance/decisions/export.csv, POST /api/compliance/erasure, GET/POST /api/compliance/breaches, GET/POST /api/compliance/processors, GET/POST /api/compliance/regions, GET/POST /api/compliance/retention',
    tables: 'oversight_records, erasure_steps, breach_register, processors, region_controls, retention_policies, audit_events',
    roles: 'admin (erasure, breach, processors, regions); recruiter read-only on incidents',
    tests: 'readiness items report real state, adverse impact uses the 0.8 four-fifths threshold with MIN_CELL_SIZE 5, CSVs export the same numbers as the view, retention dry run schedules nothing, breach goes logged → notified → closed, 7-step erasure anonymises the candidate yet retains the audit trail, double erasure returns 409',
    status: 'complete',
    notes: 'Erasure is a recorded seven-step run (stop_processing → purge_* → retain_audit). Audit rows survive by design so the deletion itself stays provable.'
  }
]

const TRANSITIONS = [
  {
    entity: 'Requisition',
    states: 'Draft → Submitted → Pending Approval → Approved → Open → Paused / Filled / Cancelled / Closed',
    rules: 'Rejected or changes-requested returns to Draft. Open required before applications or distribution. Closing withdraws live postings.'
  },
  {
    entity: 'Application',
    states: 'Applied → Parsing → Screening → Recruiter Review → Hiring Manager Review → Interview → Offer → Hired',
    rules: 'Terminal: Rejected, Withdrawn. On Hold is a controlled non-terminal state. Multi-stage jumps and rewinds require a recorded reason.'
  },
  {
    entity: 'Resume processing',
    states: 'Uploaded → Malware Scan → Queued → Parsing/OCR → Parsed → Screening Ready',
    rules: 'Failures go Retry (max 3 attempts) → Dead Letter / Manual Review. Idempotent per attempt key.'
  },
  {
    entity: 'Interview',
    states: 'Draft → Scheduled → Confirmed → Completed → Feedback Pending → Feedback Complete → Decision',
    rules: 'Cancellation and rescheduling are logged with reason and previous time.'
  },
  {
    entity: 'Offer',
    states: 'Draft → Approval Pending → Approved → Released → Accepted / Declined / Expired / Withdrawn',
    rules: 'A revision creates a new version; versions are immutable. Acceptance cascades the application to Hired and opens onboarding.'
  },
  {
    entity: 'Onboarding handoff',
    states: 'Not Started → Initiated → Documents/Tasks Pending → Ready to Join → Joined / No Show / Cancelled',
    rules: 'Recruitment handoff only — no HRMS employee lifecycle.'
  }
]

export const SpecPage = ({ user, stats }: { user: AuthUser; stats: any }) => {
  const roles = Object.keys(PERMISSIONS) as Role[]

  return (
    <Layout user={user} active="/spec" title="Spec & traceability">
      <PageHead
        title="ATS feature inventory & traceability"
        sub="Every feature maps to UI routes, API endpoints, database tables, role permissions and automated tests. This page is generated from the same constants the application uses, so it cannot drift from the implementation."
      />

      <div class="grid g4 mb16">
        <Stat label="Features tracked" value={FEATURES.length} meta={`${FEATURES.filter((f) => f.priority === 'P1').length} P1 · ${FEATURES.filter((f) => f.priority === 'P2').length} P2 · ${FEATURES.filter((f) => f.program === 'v3.0').length} v3.0`} />
        <Stat label="API tests" value={TEST_TOTAL} meta={`${stats.passing} passing · ${TEST_SUITE.api} ATS · ${TEST_SUITE.ai} AI · ${TEST_SUITE.phases} phases`} />
        <Stat label="Database tables" value={stats.tables} />
        <Stat label="Audit events" value={stats.audit} meta="recorded changes" />
      </div>

      <Card title="Traceability matrix" sub="Feature → route → API → tables → roles → tests" tight>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width:70px">ID</th><th>Feature</th><th>Phase</th><th>UI route(s)</th>
                <th>API endpoint(s)</th><th>Database tables</th><th>Roles</th><th>Tests</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {FEATURES.map((f) => (
                <tr>
                  <td><b class="mono">{f.id}</b><div class="cell-sub">{f.priority}</div></td>
                  <td class="small" style="min-width:170px"><b>{f.name}</b>{f.notes ? <div class="cell-sub" style="margin-top:3px">{f.notes}</div> : null}</td>
                  <td class="tiny">{f.phase}</td>
                  <td class="tiny mono" style="max-width:170px">{f.routes}</td>
                  <td class="tiny mono" style="max-width:230px">{f.apis}</td>
                  <td class="tiny mono" style="max-width:210px">{f.tables}</td>
                  <td class="tiny" style="max-width:150px">{f.roles}</td>
                  <td class="tiny muted" style="max-width:230px">{f.tests}</td>
                  <td><Badge tone={f.status === 'complete' ? 'ok' : 'warn'} dot>{titleCase(f.status)}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div class="grid g2 mt16">
        <Card title="Workflow & state transition rules" tight>
          <table>
            <thead><tr><th>Entity</th><th>States</th><th>Rules</th></tr></thead>
            <tbody>
              {TRANSITIONS.map((t) => (
                <tr>
                  <td class="small"><b>{t.entity}</b></td>
                  <td class="tiny mono" style="max-width:250px">{t.states}</td>
                  <td class="tiny muted" style="max-width:280px">{t.rules}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Cross-cutting acceptance requirements" tight>
          <table>
            <tbody>
              {[
                ['Page/view for every feature', 'Each of the 15 features has a routed page or panel.'],
                ['API endpoints', 'All mutations are POST/PATCH/DELETE with validation and RBAC.'],
                ['Database entities & relationships', '40 tables with FKs; migrations versioned.'],
                ['Role permissions', 'Single RBAC matrix + admin-only overrides, tested per role.'],
                ['Validations & error states', '422 for invalid transitions, 409 duplicates, 403 permissions.'],
                ['Audit events', 'actor, timestamp, previous, new, reason on every state change.'],
                ['Async processing', 'Resume pipeline with retries, idempotency keys, dead letter, manual recovery.'],
                ['AI reviewable & traceable', 'Evidence-linked output persisted in ai_runs; never auto-decides.'],
                ['Consent & retention', 'Per-channel consent, opt-out send blocking, export/erase workflows.'],
                ['Metric definitions', '10 metrics with documented numerator/denominator, UTC normalised.'],
                ['No placeholder buttons', 'Every primary action calls a real endpoint or is disabled with a reason.']
              ].map(([k, v]) => (
                <tr>
                  <td class="small" style="width:44px"><i class="fa-solid fa-circle-check" style="color:var(--ok)"></i></td>
                  <td class="small"><b>{k}</b><div class="cell-sub">{v}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card title="Permissions matrix" sub="● granted · ○ denied · ⊘ administrator-only override" tight>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Permission</th>
                {roles.map((r) => <th class="num" style="width:96px">{ROLE_LABEL[r].split(' ')[0]}</th>)}
              </tr>
            </thead>
            <tbody>
              {Array.from(new Set(Object.values(PERMISSIONS).flat())).sort().map((perm) => (
                <tr>
                  <td class="small mono">{perm}</td>
                  {roles.map((r) => {
                    const granted = PERMISSIONS[r].includes(perm)
                    const adminOnly = ADMIN_ONLY.includes(perm) && r !== 'admin'
                    return (
                      <td class="num">
                        {adminOnly ? (
                          <span style="color:var(--danger)" title="Administrator only">⊘</span>
                        ) : granted ? (
                          <i class="fa-solid fa-circle" style="color:var(--ok);font-size:8px"></i>
                        ) : (
                          <i class="fa-regular fa-circle" style="color:#d0d5dd;font-size:8px"></i>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div class="grid g2 mt16">
        <Card title="Test plan">
          <div class="small" style="line-height:1.8">
            <p><b>Suite:</b> <span class="mono">npm test</span> — runs <span class="mono">tests/api.test.mjs</span> against a live local instance with a seeded D1 database.</p>
            <p><b>Coverage areas</b></p>
            <ul style="padding-left:18px">
              <li>Authentication and per-role RBAC (403 paths)</li>
              <li>Requisition lifecycle transitions, including illegal transition rejection</li>
              <li>Application stage rules: forward step, jump without reason, rewind</li>
              <li>Duplicate detection, merge preview, merge, revert</li>
              <li>Interview feedback enforcement gate (blocked → exception → unblocked)</li>
              <li>Offer lifecycle and acceptance cascade</li>
              <li>Communications consent blocking</li>
              <li>Automation idempotency and test mode</li>
              <li>Analytics metric presence and export parity</li>
              <li>Data subject request export and erase</li>
            </ul>
          </div>
        </Card>

        <Card title="Explicit out of scope (ATS-only update)">
          <ul class="small muted" style="line-height:1.9;padding-left:18px">
            <li>Payroll and compensation processing</li>
            <li>Employee HRMS lifecycle after onboarding</li>
            <li>Vendor / agency CRM and management</li>
            <li>Campus recruitment administration</li>
            <li>Billing and subscription management</li>
            <li>Broad marketing or CMS features</li>
          </ul>
          <div class="spec-note mt16 tiny">
            Onboarding is retained only as a recruitment handoff after hire. No HRMS module exists in this codebase.
          </div>
        </Card>
      </div>
    </Layout>
  )
}
