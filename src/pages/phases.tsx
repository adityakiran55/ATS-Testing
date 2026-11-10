import { Layout } from '../components/layout'
import { PageHead, Card, Stat, Empty, Badge, Field, Bars, Meta, Timeline } from '../components/ui'
import { titleCase, fmtDate, fmtDateTime, relTime, truncate, pct } from '../lib/util'
import type { AuthUser } from '../lib/auth'
import { can } from '../lib/rbac'

const CLASS_TONE: Record<string, string> = {
  excellent: 'ok', strong: 'ok', good: 'brand', partial: 'warn',
  low: 'warn', not_qualified: 'danger', manual_review: 'violet'
}

const OUTCOME_TONE: Record<string, string> = { pass: 'ok', fail: 'danger', unknown: 'warn' }

/* ============================================================== taxonomy */

export const TaxonomyPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { summary, versions, suggestions, nodes, kindFilter } = data
  const kinds = Object.entries(summary.byKind || {}) as [string, number][]

  return (
    <Layout user={user} active="/taxonomy" title="Taxonomy">
      <PageHead
        title="Automotive taxonomy"
        sub="The governed vocabulary every match is measured against. Nothing is invented at runtime: a term enters only after a human approves it, and every version is published and reversible."
        actions={
          can(user.role, 'admin.settings') ? (
            <button class="btn" data-act="/api/taxonomy/versions" data-body='{"notes":"Draft from UI"}' data-reload="1">
              <i class="fa-solid fa-code-branch"></i> New draft version
            </button>
          ) : null
        }
      />

      <div class="grid g4 mb16">
        <Stat label="Active version" value={`v${summary.version.version}`} meta={summary.version.status} />
        <Stat label="Nodes" value={summary.nodes} meta={`${Object.keys(summary.byKind || {}).length} kinds`} />
        <Stat label="Synonym forms" value={summary.synonyms} meta="surface forms matched" />
        <Stat label="Relations" value={summary.edges} meta={`${summary.pendingSuggestions} pending suggestion(s)`} />
      </div>

      <div class="split mb16">
        <Card title="Domains" sub={`${(summary.domains || []).length} automotive domains`}>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Domain</th><th class="num">Sub-domains</th><th class="num">Roles</th></tr></thead>
              <tbody>
                {(summary.domains || []).map((d: any) => (
                  <tr>
                    <td><b>{d.name}</b><div class="tiny muted mono">{d.code}</div></td>
                    <td class="num">{d.subdomains}</td>
                    <td class="num">{d.roles}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div class="stack">
          <Card title="Node coverage" sub="Every kind in the active version">
            <Bars rows={kinds.map(([k, n]) => ({ label: titleCase(k), value: n }))} />
          </Card>

          <Card title="Version history" sub="Publishing supersedes; rollback is one click">
            <table>
              <thead><tr><th>Version</th><th>Status</th><th class="num">Nodes</th><th></th></tr></thead>
              <tbody>
                {(versions || []).map((v: any) => (
                  <tr>
                    <td><b>v{v.version}</b></td>
                    <td><Badge tone={v.status === 'active' ? 'ok' : v.status === 'draft' ? 'warn' : 'slate'}>{v.status}</Badge></td>
                    <td class="num">{v.node_count}</td>
                    <td class="nowrap">
                      {v.status === 'draft' && can(user.role, 'admin.settings') ? (
                        <button class="btn sm" data-act={`/api/taxonomy/versions/${v.id}/publish`} data-reload="1">Publish</button>
                      ) : null}
                      {v.status === 'superseded' && can(user.role, 'admin.settings') ? (
                        <button class="btn sm ghost" data-act={`/api/taxonomy/versions/${v.id}/rollback`} data-reload="1"
                          data-confirm={`Roll back to v${v.version}?`}>Roll back</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </div>

      <Card title="Suggestion queue" sub="AI and users may propose terms; only a human approves them"
        actions={summary.pendingSuggestions ? <Badge tone="warn">{summary.pendingSuggestions} pending</Badge> : null}>
        {(suggestions || []).length === 0 ? (
          <Empty icon="fa-inbox" title="No pending suggestions" sub="Proposals appear here for review before they can influence scoring." />
        ) : (
          <div class="table-wrap">
            <table>
              <thead><tr><th>Term</th><th>Source</th><th class="num">Seen</th><th>Context</th><th></th></tr></thead>
              <tbody>
                {(suggestions || []).map((s: any) => (
                  <tr>
                    <td><b>{s.term}</b><div class="tiny muted mono">{s.normalized}</div></td>
                    <td><Badge tone="slate">{s.source}</Badge></td>
                    <td class="num">{s.occurrences}</td>
                    <td class="tiny muted">{truncate(s.context, 60) || '—'}</td>
                    <td class="nowrap">
                      {can(user.role, 'admin.settings') ? (
                        <>
                          <button class="btn sm" data-act={`/api/taxonomy/suggestions/${s.id}/review`}
                            data-body='{"decision":"approved"}' data-reload="1">Approve</button>
                          <button class="btn sm ghost" data-act={`/api/taxonomy/suggestions/${s.id}/review`}
                            data-body='{"decision":"rejected"}' data-reload="1">Reject</button>
                        </>
                      ) : <span class="tiny muted">Admin review</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Browse nodes" sub="Filter the active version"
        actions={
          <form method="get" action="/taxonomy" class="row gap8">
            <input name="kind" value={kindFilter || ''} placeholder="kind, e.g. job_role" style="width:150px" />
            <input name="q" value={data.q || ''} placeholder="search name" style="width:160px" />
            <button class="btn sm" type="submit">Filter</button>
          </form>
        }>
        {(nodes || []).length === 0 ? <Empty title="No nodes match" /> : (
          <div class="table-wrap">
            <table>
              <thead><tr><th>Node</th><th>Kind</th><th>Parent</th><th>Synonyms</th></tr></thead>
              <tbody>
                {(nodes || []).slice(0, 120).map((n: any) => (
                  <tr>
                    <td><b>{n.name}</b><div class="tiny muted mono">{n.code}</div></td>
                    <td><Badge tone="slate">{titleCase(n.kind)}</Badge></td>
                    <td class="tiny muted">{n.parent_name || '—'}</td>
                    <td class="tiny muted">{n.synonym_list?.length ? n.synonym_list.join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Layout>
  )
}

/* ============================================================= screening */

export const ScreeningQueuePage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { queue, stats } = data
  const canDecide = can(user.role, 'application.move')

  return (
    <Layout user={user} active="/screening" title="Screening review">
      <PageHead
        title="Screening review queue"
        sub="Every classification is advisory. The engine cannot reject, advance or withdraw an application — a named person records the decision, with a reason, and that is what the audit trail and the compliance export read."
      />

      <div class="grid g4 mb16">
        <Stat label="Runs" value={stats.runs} meta={`${stats.undecided} awaiting decision`} />
        <Stat label="Human decision rate" value={`${stats.humanDecisionRate}%`} meta="runs signed off by a person"
          tone={stats.humanDecisionRate < 100 ? 'var(--warn)' : undefined} />
        <Stat label="Routed to manual review" value={stats.manualReview} meta="a queue, not a rejection" />
        <Stat label="Avg evidence coverage" value={`${stats.avgCoverage}%`} meta="verified spans per run" />
      </div>

      <div class="spec-note mb16">
        <b>Why some runs land in manual review:</b> a failed knock-out rule, fewer than three verifiable
        evidence rows, evidence coverage below 55%, or a requisition with no must-have requirements.
        The engine reports the reason on each run rather than guessing a class.
      </div>

      <Card title="Awaiting decision" sub={`${(queue || []).length} run(s)`} tight>
        {(queue || []).length === 0 ? (
          <Empty icon="fa-circle-check" title="Nothing awaiting review"
            sub="Run screening from a requisition to populate this queue." />
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Candidate</th><th>Requisition</th><th>Machine class</th><th class="num">Score</th>
                  <th class="num">Evidence</th><th>Confidence</th><th></th>
                </tr>
              </thead>
              <tbody>
                {(queue || []).map((r: any) => (
                  <tr>
                    <td>
                      <b>{r.first_name} {r.last_name}</b>
                      <div class="tiny muted">{r.email}</div>
                    </td>
                    <td class="small">{truncate(r.job_title, 26)}<div class="tiny muted mono">{r.job_code}</div></td>
                    <td><Badge tone={CLASS_TONE[r.class] || 'slate'}>{titleCase(r.class)}</Badge></td>
                    <td class="num">{r.score}</td>
                    <td class="num">{r.evidence_rows}<span class="tiny muted"> · {Math.round(r.evidence_coverage || 0)}%</span></td>
                    <td><Badge tone={r.confidence === 'high' ? 'ok' : r.confidence === 'medium' ? 'warn' : 'danger'}>{r.confidence}</Badge></td>
                    <td class="nowrap"><a class="btn sm" href={`/screening/runs/${r.id}`}>Review</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Class distribution" sub="Across all runs">
        {(stats.byClass || []).length === 0 ? <Empty title="No runs yet" /> : (
          <Bars rows={(stats.byClass || []).map((b: any) => ({ label: titleCase(b.class), value: b.n }))} />
        )}
      </Card>
    </Layout>
  )
}

export const ScreeningRunPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { run, labels } = data
  const canDecide = can(user.role, 'application.move')
  const decided = Boolean(run.decided_at)
  const dims = Object.entries(run.dimensions || {}) as [string, number][]

  return (
    <Layout user={user} active="/screening" title="Screening run">
      <PageHead
        title={`${run.first_name} ${run.last_name}`}
        sub={`${run.job_title} · ${run.job_code} · run #${run.id} · advisory classification`}
        actions={<a class="btn" href="/screening"><i class="fa-solid fa-arrow-left"></i> Queue</a>}
      />

      <div class="grid g4 mb16">
        <Stat label="Machine class" value={titleCase(run.class)} tone={`var(--${CLASS_TONE[run.class] === 'ok' ? 'ok' : 'ink'})`}
          meta={`score ${run.score}`} />
        <Stat label="Confidence" value={run.confidence} meta={`profile v${run.profile_id ? 'set' : 'default'}`} />
        <Stat label="Verified evidence" value={run.verifiedEvidence} meta={`${run.evidenceCoverage}% coverage`} />
        <Stat label="Decision" value={run.decision ? titleCase(run.decision) : 'Pending'}
          meta={run.decided_at ? `${run.decided_by_name} · ${relTime(run.decided_at)}` : 'needs a named reviewer'} />
      </div>

      {run.summary ? (
        <div class="spec-note mb16"><b>Why this class:</b> {run.summary}</div>
      ) : null}

      <div class="split mb16">
        <Card title="Dimension scores" sub="Weighted; each is backed by verified evidence">
          <Bars rows={dims.map(([k, v]) => ({ label: titleCase(k), value: Math.round(v) }))} unit="%" />
          <div class="spec-note mt16 tiny">
            Scoring input is masked before computation: name, contact details, gender, age, address,
            caste, religion and nationality are removed so they cannot influence any dimension.
          </div>
        </Card>

        <Card title="Knock-out rules" sub="A failure routes to a human — it does not reject">
          {(run.knockouts || []).length === 0 ? <Empty title="No knock-out rules configured" /> : (
            <table>
              <thead><tr><th>Rule</th><th>Outcome</th><th>Detail</th></tr></thead>
              <tbody>
                {(run.knockouts || []).map((k: any) => (
                  <tr>
                    <td class="small"><b>{k.label}</b></td>
                    <td><Badge tone={OUTCOME_TONE[k.outcome] || 'slate'}>{k.outcome}</Badge></td>
                    <td class="tiny muted">{k.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Evidence" sub={`${run.verifiedEvidence} verified span(s) — each quotes the source document`} tight>
        {(run.evidence || []).length === 0 ? (
          <Empty icon="fa-quote-left" title="No verifiable evidence survived"
            sub="Without provable spans a classification cannot be defended, which is why this run needs a human." />
        ) : (
          <div class="table-wrap">
            <table>
              <thead><tr><th>Dimension</th><th>Claim</th><th>Quoted evidence</th><th class="num">Span</th><th>Verified</th></tr></thead>
              <tbody>
                {(run.evidence || []).map((e: any) => (
                  <tr>
                    <td><Badge tone="slate">{titleCase(e.dimension)}</Badge></td>
                    <td class="small">{e.claim}</td>
                    <td class="tiny"><span class="mono">{truncate(e.evidence, 90)}</span></td>
                    <td class="num tiny mono">{e.char_start}–{e.char_end}</td>
                    <td>{Number(e.verified) === 1 ? <Badge tone="ok">verified</Badge> : <Badge tone="danger">unverified</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {(run.overrides || []).length || (run.oversight || []).length ? (
        <Card title="Human review history" sub="Overrides and oversight records">
          <Timeline items={[
            ...(run.oversight || []).map((h: any) => ({
              title: `${titleCase(h.review_kind)} by ${h.reviewer_name}`,
              meta: fmtDateTime(h.reviewed_at),
              body: <span class="small">{h.reason || '—'} <span class="tiny muted">({h.machine_class} → {h.final_class})</span></span>,
              tone: h.review_kind === 'overridden' ? 'warn' : ''
            }))
          ]} />
        </Card>
      ) : null}

      {!decided && canDecide ? (
        <Card title="Record a decision" sub="Required: a reason of at least five characters. This is the only path from an advisory class to an outcome.">
          <form data-api={`/api/screening/runs/${run.id}/decide`} data-method="post" data-reload="1">
            <div class="form-grid">
              <Field label="Decision">
                <select name="decision">
                  <option value="accepted">Accept the machine class</option>
                  <option value="overridden">Override to a different class</option>
                  <option value="escalated">Escalate to hiring manager</option>
                  <option value="rejected">Reject this screening result</option>
                </select>
              </Field>
              <Field label="Final class (if overriding)">
                <select name="final_class">
                  <option value="">Keep machine class</option>
                  <option value="excellent">Excellent</option>
                  <option value="strong">Strong</option>
                  <option value="good">Good</option>
                  <option value="partial">Partial</option>
                  <option value="low">Low</option>
                  <option value="not_qualified">Not qualified</option>
                  <option value="manual_review">Manual review</option>
                </select>
              </Field>
              <Field label="Reason" full help="Stored on the run, the override record and the oversight log.">
                <textarea name="reason" rows={3} placeholder="e.g. Candidate's BIW experience is evidenced in two roles; machine under-scored tooling." required />
              </Field>
            </div>
            <button class="btn primary mt8" type="submit"><i class="fa-solid fa-check"></i> Record decision</button>
          </form>
        </Card>
      ) : decided ? (
        <div class="spec-note">
          <b>Decision recorded</b> by {run.decided_by_name} on {fmtDateTime(run.decided_at)} — {titleCase(run.decision)}.
          A second decision requires a new run, so history is never rewritten.
        </div>
      ) : (
        <div class="spec-note">You do not have permission to record a screening decision.</div>
      )}
    </Layout>
  )
}

/* =================================================================== JD */

export const JdPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { job, versions, analysis, coverage, requirements } = data
  const errors = (analysis.issues || []).filter((i: any) => i.severity === 'error')
  const warns = (analysis.issues || []).filter((i: any) => i.severity === 'warn')

  return (
    <Layout user={user} active="/jobs" title="Job description">
      <PageHead
        title={`JD builder — ${job.title}`}
        sub="Diagnosis and extraction only. Validation reports what to fix; it never silently rewrites your description, and every save is an immutable version you can diff."
        actions={<a class="btn" href={`/jobs/${job.id}`}><i class="fa-solid fa-arrow-left"></i> Requisition</a>}
      />

      <div class="grid g4 mb16">
        <Stat label="Quality score" value={analysis.scores.total} meta="clarity 40% · inclusivity 30% · specificity 30%" />
        <Stat label="Must-haves" value={analysis.coverage.mustHaves} meta={`${analysis.coverage.niceToHaves} nice-to-have`} />
        <Stat label="Taxonomy-resolved" value={analysis.coverage.taxonomyResolved}
          meta={`of ${analysis.coverage.mustHaves + analysis.coverage.niceToHaves} listed`} />
        <Stat label="Issues" value={`${errors.length} / ${warns.length}`} meta="errors / warnings"
          tone={errors.length ? 'var(--danger)' : undefined} />
      </div>

      <div class="split mb16">
        <Card title="Validation" sub="Errors must be fixed before screening is defensible">
          {(analysis.issues || []).length === 0 ? (
            <Empty icon="fa-circle-check" title="No issues found" />
          ) : (
            <div class="stack">
              {(analysis.issues || []).map((i: any) => (
                <div class={i.severity === 'error' ? 'danger-note' : i.severity === 'warn' ? 'warn-note' : 'spec-note'}>
                  <b>{i.message}</b>
                  <div class="tiny muted mt4">{i.hint || ''} <span class="mono">[{i.code} · {i.field}]</span></div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div class="stack">
          <Card title="Pool coverage" sub="Would this requisition actually find anyone?">
            {coverage ? (
              <>
                <Meta items={[
                  ['Pool scanned', String(coverage.poolSize)],
                  ['Any must-have', `${coverage.candidatesWithAnyMustHave} (${coverage.anyPct}%)`],
                  ['All must-haves', `${coverage.candidatesWithAllMustHaves} (${coverage.allPct}%)`]
                ]} />
                {(coverage.hardestRequirements || []).length ? (
                  <div class="mt16">
                    <div class="field">Hardest requirements</div>
                    <Bars rows={coverage.hardestRequirements.map((h: any) => ({
                      label: h.requirement, value: h.missing, sub: `${h.missingPct}% missing`
                    }))} />
                  </div>
                ) : null}
              </>
            ) : <Empty title="No coverage data" />}
          </Card>

          <Card title="Suggested roles" sub="Derived from the title and description">
            {(analysis.suggestedRoles || []).length === 0 ? <Empty title="No close roles" /> : (
              <table>
                <thead><tr><th>Role</th><th class="num">Fit</th></tr></thead>
                <tbody>
                  {(analysis.suggestedRoles || []).map((r: any) => (
                    <tr><td>{r.name}<div class="tiny muted mono">{r.code}</div></td><td class="num">{r.score}%</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>

      <Card title="Extracted requirements" sub={`${(requirements || []).length} with source offsets`}
        actions={can(user.role, 'job.edit') ? (
          <button class="btn sm" data-act={`/api/jobs/${job.id}/jd/versions`} data-body='{"status":"draft"}'
            data-reload="1"><i class="fa-solid fa-floppy-disk"></i> Snapshot version</button>
        ) : null}>
        {(requirements || []).length === 0 ? (
          <Empty title="No requirements extracted"
            sub="Save a version to extract requirements from the description and declared skills." />
        ) : (
          <div class="table-wrap">
            <table>
              <thead><tr><th>Requirement</th><th>Kind</th><th>Taxonomy</th><th class="num">Span</th></tr></thead>
              <tbody>
                {(requirements || []).map((r: any) => (
                  <tr>
                    <td class="small">{r.text}</td>
                    <td><Badge tone={r.kind === 'must_have' ? 'brand' : 'slate'}>{titleCase(r.kind)}</Badge></td>
                    <td>{r.node_id ? <Badge tone="ok">resolved</Badge> : <Badge tone="warn">free text</Badge>}</td>
                    <td class="num tiny mono">{r.char_start}–{r.char_end}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Version history" sub="Immutable snapshots">
        {(versions || []).length === 0 ? <Empty title="No versions saved yet" /> : (
          <table>
            <thead><tr><th>Version</th><th>Status</th><th class="num">Requirements</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {(versions || []).map((v: any) => (
                <tr>
                  <td><b>v{v.version}</b></td>
                  <td><Badge tone={v.status === 'approved' ? 'ok' : 'slate'}>{v.status}</Badge></td>
                  <td class="num">{v.requirement_count}</td>
                  <td class="tiny muted">{fmtDate(v.created_at)} · {v.created_by_name || '—'}</td>
                  <td><a class="btn sm ghost" href={`/api/jd/versions/${v.id}`} target="_blank">JSON</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Layout>
  )
}

/* =============================================================== pipeline */

export const BoardPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { board, funnel, jobs, jobId } = data
  const canMove = can(user.role, 'application.move')

  return (
    <Layout user={user} active="/board" title="Pipeline board">
      <PageHead
        title="12-stage pipeline"
        sub="The client-facing view of the v2.0 stage machine. Every move is validated, writes both the v3.0 and legacy stage, and records the actor, timestamp and reason."
        actions={
          <form method="get" action="/board" class="row gap8">
            <select name="job" style="width:220px">
              <option value="">All requisitions</option>
              {jobs.map((j: any) => <option value={j.id} selected={String(jobId) === String(j.id)}>{j.title}</option>)}
            </select>
            <button class="btn sm" type="submit">Filter</button>
          </form>
        }
      />

      <Card title="Funnel" sub="Counts by v3.0 stage">
        <FunnelChartSafe funnel={funnel} />
      </Card>

      <div class="board mb16">
        {(board.columns || []).map((col: any) => (
          <div class="board-col">
            <div class="board-head">
              <b>{col.label}</b>
              <Badge tone={col.is_terminal ? 'slate' : 'brand'}>{col.count}</Badge>
            </div>
            {(col.cards || []).slice(0, 12).map((c: any) => (
              <a class="board-card" href={`/applications/${c.id}`}>
                <div class="row between">
                  <b class="small">{c.first_name} {c.last_name}</b>
                  {c.latest_class ? <Badge tone={CLASS_TONE[c.latest_class] || 'slate'}>{c.latest_class}</Badge> : null}
                </div>
                <div class="tiny muted">{truncate(c.job_title, 28)}</div>
                <div class="tiny muted">{relTime(c.stage_entered_at)}{c.runs ? ` · ${c.runs} run(s)` : ''}</div>
              </a>
            ))}
            {col.count > 12 ? <div class="tiny muted center">+{col.count - 12} more</div> : null}
            {col.count === 0 ? <div class="tiny muted center" style="padding:10px">Empty</div> : null}
          </div>
        ))}
      </div>

      <Card title="Why the mapping is safe" sub="One source of truth for validation">
        <div class="spec-note">
          The legacy <span class="mono">stage</span> + <span class="mono">status</span> columns still drive analytics,
          SLA and the existing screens. Each v3.0 move derives them from a declared table rather than free text, so the
          two views can never disagree. Terminal stages (Joined, Rejected, Withdrawn) accept no further moves —
          reopening creates a new application instead of rewriting history.
        </div>
        {can(user.role, 'admin.settings') ? (
          <button class="btn mt8" data-act="/api/pipeline/backfill" data-reload="1">
            <i class="fa-solid fa-wand-magic-sparkles"></i> Re-derive stages for all applications
          </button>
        ) : null}
      </Card>
    </Layout>
  )
}

const FunnelChartSafe = ({ funnel }: { funnel: any[] }) => {
  const max = Math.max(1, ...(funnel || []).map((f) => f.count))
  return (
    <div class="funnel">
      {(funnel || []).map((f) => (
        <div class="funnel-row">
          <div class="stage">{f.label || titleCase(f.stage)}</div>
          <div class="track"><span style={`width:${Math.max(5, Math.round((f.count / max) * 100))}%`}>{f.count}</span></div>
          <div class="conv">{f.conversion_from_previous}%</div>
        </div>
      ))}
    </div>
  )
}

/* ============================================================= compliance */

export const CompliancePage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { overview, impact, reports } = data
  const isAdmin = can(user.role, 'admin.settings')

  return (
    <Layout user={user} active="/compliance" title="Compliance">
      <PageHead
        title="Compliance pack"
        sub="Bias monitoring, human oversight, decision export, erasure, breach register, processors and region controls — each backed by a record rather than a claim."
        actions={
          <a class="btn" href="/api/compliance/decisions/export.csv">
            <i class="fa-solid fa-file-csv"></i> Decision log CSV
          </a>
        }
      />

      <Card title="Readiness" sub="Honest status per control — green means the record exists, not that the box was ticked">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Control</th><th>Status</th><th>Evidence</th></tr></thead>
            <tbody>
              {(overview.readiness || []).map((c: any) => (
                <tr>
                  <td class="small"><b>{c.control}</b></td>
                  <td>{c.ok ? <Badge tone="ok"><i class="fa-solid fa-check"></i> met</Badge> : <Badge tone="warn">gap</Badge>}</td>
                  <td class="tiny muted">{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div class="grid g4 mb16 mt16">
        <Stat label="Screening runs" value={overview.oversight.runs} meta={`${overview.oversight.humanDecided} human-decided`} />
        <Stat label="Automatic rejections" value={overview.oversight.autoRejections} meta="must stay at zero"
          tone={overview.oversight.autoRejections === 0 ? 'var(--ok)' : 'var(--danger)'} />
        <Stat label="Notices issued" value={overview.notices.total} meta={`${overview.notices.acknowledged} acknowledged`} />
        <Stat label="Open incidents" value={overview.breaches.open} meta={`${overview.breaches.total} total`}
          tone={overview.breaches.open ? 'var(--danger)' : undefined} />
      </div>

      <div class="split mb16">
        <Card title="Adverse impact" sub={`Reference: ${impact.reference ? `${impact.reference.group_value} (${impact.reference.selection_rate}%)` : 'not enough data'}`}
          actions={<a class="btn sm ghost" href="/api/compliance/adverse-impact/export.csv">CSV</a>}>
          <div class="spec-note mb16 tiny">{impact.methodology}</div>
          {(impact.groups || []).length === 0 ? (
            <Empty icon="fa-chart-simple" title="No demographic data captured"
              sub="Impact ratios need voluntary, separate demographic data. Nothing here is inferred." />
          ) : (
            <table>
              <thead><tr><th>Group</th><th class="num">Considered</th><th class="num">Selected</th><th class="num">Rate</th><th class="num">Impact</th></tr></thead>
              <tbody>
                {(impact.groups || []).map((g: any) => (
                  <tr>
                    <td class="small"><b>{g.group_value}</b><div class="tiny muted mono">{g.group_key}</div></td>
                    <td class="num">{g.considered}</td>
                    <td class="num">{g.selected}</td>
                    <td class="num">{g.suppressed ? <span class="tiny muted">suppressed</span> : `${g.selection_rate}%`}</td>
                    <td class="num">
                      {g.suppressed ? '—' : g.impact_ratio === null ? '—' : (
                        <Badge tone={g.below_threshold ? 'danger' : 'ok'}>{g.impact_ratio}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {impact.suppressed_cells ? (
            <div class="tiny muted mt8">{impact.suppressed_cells} cell(s) suppressed (fewer than 5 applications) to prevent re-identification.</div>
          ) : null}
        </Card>

        <div class="stack">
          <Card title="Region controls" sub="Turning a region on activates its safeguards">
            <table>
              <thead><tr><th>Region</th><th>Status</th><th class="num">Safeguards</th><th></th></tr></thead>
              <tbody>
                {(overview.regions || []).map((r: any) => (
                  <tr>
                    <td><b>{r.region}</b></td>
                    <td>{Number(r.enabled) === 1 ? <Badge tone="ok">enabled</Badge> : <Badge tone="slate">off</Badge>}</td>
                    <td class="num">{r.requirements.length}</td>
                    <td>
                      {isAdmin ? (
                        <button class="btn sm ghost"
                          data-act={`/api/compliance/regions/${r.region}`}
                          data-method="PATCH"
                          data-body={JSON.stringify({ enabled: Number(r.enabled) !== 1 })}
                          data-confirm={`${Number(r.enabled) === 1 ? 'Disable' : 'Enable'} ${r.region}?`}
                          data-reload="1">
                          {Number(r.enabled) === 1 ? 'Disable' : 'Enable'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Retention timer" sub="Notice first, erasure only after the window">
            <Meta items={[
              ['Policy', overview.retention.policy ? `${overview.retention.policy.months} months` : 'none'],
              ['Pre-deletion notice', overview.retention.policy ? `${overview.retention.policy.preDeletionDays} days` : '—'],
              ['Expiring ≤30d', String(overview.retention.expiringIn30Days)],
              ['Noticed', String(overview.retention.noticeSent)],
              ['Due for erasure', String(overview.retention.dueForErasure)]
            ]} />
            {isAdmin ? (
              <div class="row gap8 mt8">
                <button class="btn sm ghost" data-act="/api/compliance/retention/run"
                  data-body='{"dry_run":true}' data-reload="1">Dry run</button>
                <button class="btn sm" data-act="/api/compliance/retention/run" data-reload="1"
                  data-confirm="Issue pre-deletion notices for expired records? Nothing is deleted.">Run sweep</button>
              </div>
            ) : null}
          </Card>
        </div>
      </div>

      <div class="split mb16">
        <Card title="Processors" sub="Every model provider that touches candidate text">
          <table>
            <thead><tr><th>Processor</th><th>Role</th><th>Location</th><th>DPA</th></tr></thead>
            <tbody>
              {(overview.processors || []).map((p: any) => (
                <tr>
                  <td class="small"><b>{p.name}</b><div class="tiny muted">{p.data_categories.join(', ')}</div></td>
                  <td><Badge tone="slate">{titleCase(p.role)}</Badge></td>
                  <td class="tiny">{p.location || '—'}</td>
                  <td>{Number(p.dpa_signed) === 1 ? <Badge tone="ok">signed</Badge> : <Badge tone="warn">missing</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {isAdmin ? (
            <form class="mt16" data-api="/api/compliance/processors" data-method="post" data-reload="1">
              <div class="form-grid">
                <Field label="Processor name"><input name="name" required placeholder="e.g. Anthropic" /></Field>
                <Field label="Location"><input name="location" placeholder="US / EU / on-premise" /></Field>
              </div>
              <button class="btn sm primary mt8" type="submit">Add processor</button>
            </form>
          ) : null}
        </Card>

        <Card title="Breach register" sub="DPDP: notify the board within 72 hours where reportable">
          {(overview.breaches.items || []).length === 0 ? (
            <Empty icon="fa-shield-halved" title="No incidents recorded" />
          ) : (
            <table>
              <thead><tr><th>Ref</th><th>Title</th><th>Severity</th><th>Status</th></tr></thead>
              <tbody>
                {(overview.breaches.items || []).map((b: any) => (
                  <tr>
                    <td class="mono tiny">{b.ref}</td>
                    <td class="small">{truncate(b.title, 30)}</td>
                    <td><Badge tone={b.severity === 'critical' ? 'danger' : b.severity === 'high' ? 'warn' : 'slate'}>{b.severity}</Badge></td>
                    <td>{b.closed_at ? <Badge tone="ok">closed</Badge> : <Badge tone="danger">open</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {isAdmin ? (
            <form class="mt16" data-api="/api/compliance/breaches" data-method="post" data-reload="1">
              <div class="form-grid">
                <Field label="Incident title"><input name="title" required placeholder="e.g. Exposed staging bucket" /></Field>
                <Field label="Severity">
                  <select name="severity">
                    <option value="low">Low</option><option value="medium" selected>Medium</option>
                    <option value="high">High</option><option value="critical">Critical</option>
                  </select>
                </Field>
                <Field label="Description" full><textarea name="description" rows={2} /></Field>
              </div>
              <button class="btn sm primary mt8" type="submit">Log incident</button>
            </form>
          ) : null}
        </Card>
      </div>

      <Card title="Saved adverse-impact reports" sub="Each generation is written with its period and payload">
        {(reports || []).length === 0 ? <Empty title="No reports generated" /> : (
          <table>
            <thead><tr><th>#</th><th>Requisition</th><th>Period</th><th class="num">Flags</th><th>By</th><th>When</th></tr></thead>
            <tbody>
              {(reports || []).map((r: any) => (
                <tr>
                  <td class="mono tiny">{r.id}</td>
                  <td class="small">{r.job_id ? `#${r.job_id}` : 'All'}</td>
                  <td class="tiny muted">{(r.period_from || '—').slice(0, 10)} → {(r.period_to || '—').slice(0, 10)}</td>
                  <td class="num">{(r.payload?.flags || []).length}</td>
                  <td class="tiny">{r.generated_by_name || '—'}</td>
                  <td class="tiny muted">{relTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Layout>
  )
}
