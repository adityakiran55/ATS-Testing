import { Layout } from '../components/layout'
import { PageHead, Card, Stat, Empty, Badge, AgingPill, Person, Bars, Field } from '../components/ui'
import { titleCase, truncate, fmtDate, relTime } from '../lib/util'
import type { AuthUser } from '../lib/auth'
import { can } from '../lib/rbac'

export const SlaPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { aging, workload, requisitionAging, slas, ruleRuns } = data
  const stages = Object.entries(aging.summary.by_stage || {}) as [string, any][]

  return (
    <Layout user={user} active="/sla" title="SLA & aging">
      <PageHead
        title="Recruiter SLA & stage aging"
        sub="Time in stage is measured from stage_entered_at in UTC. Thresholds are configurable per stage; breaches raise escalations and appear in the overdue queue."
        actions={
          <>
            <button class="btn" data-act="/api/sla/escalate" data-reload="1"><i class="fa-solid fa-bell"></i> Escalate overdue</button>
            {can(user.role, 'admin.settings') ? <a class="btn" href="/settings">SLA settings</a> : null}
          </>
        }
      />

      <div class="grid g4 mb16">
        <Stat label="Active applications" value={aging.summary.active} />
        <Stat label="Past SLA" value={aging.summary.overdue} tone={aging.summary.overdue ? 'var(--danger)' : undefined}
          meta={`${aging.summary.overdue_pct}% of active`} />
        <Stat label="Avg stage age" value={`${Math.round(aging.rows.reduce((s: number, r: any) => s + r.hours_in_stage, 0) / (aging.rows.length || 1))}h`} />
        <Stat label="Escalation rule runs" value={ruleRuns} meta="automation executions" />
      </div>

      <div class="split mb16">
        <Card title="Overdue queue" tight sub={`${aging.overdue.length} applications past threshold`}
          actions={<a class="btn ghost sm" href="/pipeline">Pipeline</a>}>
          {aging.overdue.length === 0 ? <Empty icon="fa-circle-check" title="No SLA breaches" /> : (
            <div class="table-wrap">
              <table>
                <thead><tr><th>Candidate</th><th>Requisition</th><th>Stage</th><th>In stage</th><th>Recruiter</th><th></th></tr></thead>
                <tbody>
                  {aging.overdue.slice(0, 30).map((r: any) => (
                    <tr>
                      <td class="small"><b>{r.candidate_name}</b></td>
                      <td class="small">{truncate(r.job_title, 24)}</td>
                      <td><Badge tone="warn">{titleCase(r.stage)}</Badge></td>
                      <td class="nowrap"><AgingPill hours={r.hours_in_stage} threshold={r.threshold_hours} /></td>
                      <td class="tiny">{r.recruiter_name || '—'}</td>
                      <td class="nowrap"><a class="btn sm" href={`/applications/${r.application_id}`}>Open</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div class="stack">
          <Card title="Stage thresholds">
            <table>
              <thead><tr><th>Stage</th><th class="num">SLA</th><th class="num">Active</th><th class="num">Overdue</th></tr></thead>
              <tbody>
                {stages.map(([stage, s]) => (
                  <tr>
                    <td class="small">{titleCase(stage)}</td>
                    <td class="num small">{s.threshold}h</td>
                    <td class="num small">{s.active}</td>
                    <td class="num small">{s.overdue > 0 ? <Badge tone="danger">{s.overdue}</Badge> : '0'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Recruiter workload">
            <Bars rows={workload.map((w: any) => ({ label: w.name, value: w.active_applications }))} />
            <hr />
            <table>
              <thead><tr><th>Recruiter</th><th class="num">Reqs</th><th class="num">Overdue</th><th class="num">Load</th></tr></thead>
              <tbody>
                {workload.map((w: any) => (
                  <tr>
                    <td class="small">{w.name}</td>
                    <td class="num small">{w.open_requisitions}</td>
                    <td class="num small">{w.overdue > 0 ? <Badge tone="danger">{w.overdue}</Badge> : '0'}</td>
                    <td class="num small">{w.load_score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </div>

      <Card title="Requisition aging" tight sub="Open requisitions by age, with fill progress and target tracking">
        {requisitionAging.length === 0 ? <Empty icon="fa-briefcase" title="No active requisitions" /> : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>Requisition</th><th>Status</th><th class="num">Days open</th><th class="num">Apps</th><th class="num">Hires</th><th>Fill progress</th><th>Target</th></tr>
              </thead>
              <tbody>
                {requisitionAging.map((j: any) => (
                  <tr>
                    <td><a href={`/jobs/${j.id}`} class="cell-main small" style="text-decoration:none">{j.title}</a><div class="cell-sub mono">{j.code} · {j.location}</div></td>
                    <td><Badge tone={j.status === 'open' ? 'ok' : j.status === 'paused' ? 'warn' : 'slate'} dot>{titleCase(j.status)}</Badge></td>
                    <td class="num small">{j.days_open}</td>
                    <td class="num small">{j.applications}</td>
                    <td class="num small">{j.hires}</td>
                    <td style="width:130px">
                      <div class={`bar ${j.fill_progress >= 100 ? 'ok' : ''}`}><span style={`width:${j.fill_progress}%`}></span></div>
                      <div class="tiny muted" style="margin-top:3px">{j.fill_progress}%</div>
                    </td>
                    <td class="small nowrap">
                      {j.days_to_target === null ? '—' : j.past_target
                        ? <Badge tone="danger">{-j.days_to_target}d over</Badge>
                        : <span class="muted">{j.days_to_target}d left</span>}
                    </td>
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

export const AutomationPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { rules, runs, events } = data
  return (
    <Layout user={user} active="/automation" title="Automation">
      <PageHead
        title="Recruitment workflow automation"
        sub="Trigger → condition → action rules. Execution is idempotent per event key, retries are bounded, failures are visible, and test mode evaluates conditions without side effects."
        actions={can(user.role, 'admin.settings') ? <button class="btn primary" onclick="openModal('rule-modal')"><i class="fa-solid fa-plus"></i> New rule</button> : null}
      />

      <div class="grid g4 mb16">
        <Stat label="Rules" value={rules.length} meta={`${rules.filter((r: any) => r.enabled).length} enabled`} />
        <Stat label="Executions" value={rules.reduce((s: number, r: any) => s + r.run_count, 0)} />
        <Stat label="Failures" value={rules.reduce((s: number, r: any) => s + r.fail_count, 0)} tone={rules.some((r: any) => r.fail_count > 0) ? 'var(--warn)' : undefined} />
        <Stat label="Test mode" value={rules.filter((r: any) => r.test_mode).length} meta="Evaluating without side effects" />
      </div>

      <div class="stack mb16">
        {rules.map((r: any) => (
          <Card key={r.id} title={r.name}
            sub={`on ${r.trigger_event}`}
            actions={
              <>
                {r.test_mode ? <Badge tone="warn">test mode</Badge> : null}
                <Badge tone={r.enabled ? 'ok' : 'slate'} dot>{r.enabled ? 'Enabled' : 'Disabled'}</Badge>
                <button class="btn sm" data-act={`/api/automation/rules/${r.id}`} data-method="PATCH" data-body={JSON.stringify({ enabled: !r.enabled })} data-reload="1">
                  {r.enabled ? 'Disable' : 'Enable'}
                </button>
                <button class="btn sm" data-act={`/api/automation/rules/${r.id}`} data-method="PATCH" data-body={JSON.stringify({ test_mode: !r.test_mode })} data-reload="1">
                  {r.test_mode ? 'Go live' : 'Test mode'}
                </button>
                <button class="btn sm ghost" data-act={`/api/automation/rules/${r.id}/test`} data-reload="1">Dry run</button>
              </>
            }>
            <div class="grid g3" style="gap:14px">
              <div>
                <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-bottom:5px">Trigger</div>
                <span class="mono small">{r.trigger_event}</span>
              </div>
              <div>
                <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-bottom:5px">Conditions</div>
                {r.condition_list.length === 0 ? <span class="small muted">Always</span> : r.condition_list.map((c: any) => (
                  <div class="small mono">{c.field} {c.op} {JSON.stringify(c.value)}</div>
                ))}
              </div>
              <div>
                <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-bottom:5px">Actions</div>
                {r.action_list.map((a: any) => (
                  <div class="small"><Badge tone="brand">{a.type}</Badge> {a.title || a.template_id ? <span class="tiny muted">{a.title || `template #${a.template_id}`}</span> : null}</div>
                ))}
              </div>
            </div>
            <hr />
            <div class="row between small muted">
              <span>Runs {r.run_count} · failures {r.fail_count} · last {r.last_run_at ? relTime(r.last_run_at) : 'never'}</span>
              <span class="tiny">{r.description || ''}</span>
            </div>
          </Card>
        ))}
      </div>

      <div class="grid g2">
        <Card title="Execution log" tight sub={`${runs.length} recent runs`}>
          {runs.length === 0 ? <Empty icon="fa-list" title="No executions" /> : (
            <div class="table-wrap" style="max-height:420px;overflow-y:auto">
              <table>
                <thead><tr><th>Rule</th><th>Event</th><th>Status</th><th>Attempts</th><th>When</th></tr></thead>
                <tbody>
                  {runs.map((r: any) => (
                    <tr>
                      <td class="small">{r.rule_name || `Rule ${r.rule_id}`}</td>
                      <td class="tiny mono">{r.event_name}<div class="cell-sub">{r.detail || ''}</div></td>
                      <td><Badge tone={r.status === 'success' ? 'ok' : r.status === 'failed' ? 'danger' : r.status === 'test' ? 'violet' : 'slate'} dot>{titleCase(r.status)}</Badge></td>
                      <td class="num tiny">{r.attempts}</td>
                      <td class="tiny muted nowrap">{relTime(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Event queue" tight sub="Idempotent event keys">
          {events.length === 0 ? <Empty icon="fa-inbox" title="Queue empty" /> : (
            <div class="table-wrap" style="max-height:420px;overflow-y:auto">
              <table>
                <thead><tr><th>Event</th><th>Key</th><th>Status</th></tr></thead>
                <tbody>
                  {events.map((e: any) => (
                    <tr>
                      <td class="small">{e.event_name}</td>
                      <td class="tiny mono">{e.event_key.slice(0, 26)}…</td>
                      <td><Badge tone={e.status === 'processed' ? 'ok' : e.status === 'failed' ? 'danger' : 'warn'} dot>{titleCase(e.status)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <dialog class="modal" id="rule-modal">
        <header><h3>New automation rule</h3><button class="btn ghost sm" onclick="closeModal('rule-modal')"><i class="fa-solid fa-xmark"></i></button></header>
        <form data-api="/api/automation/rules" data-method="post" data-reload="1">
          <div class="body">
            <div class="form-grid">
              <Field label="Rule name" full><input type="text" name="name" required placeholder="Acknowledge every new application" /></Field>
              <Field label="Trigger event">
                <select name="trigger_event">
                  {['application.created', 'application.stage_changed', 'application.rejected',
                    'interview.scheduled', 'interview.completed', 'offer.released', 'job.aged'].map((e) => <option>{e}</option>)}
                </select>
              </Field>
              <Field label="Condition field"><input type="text" name="cond_field" placeholder="to_stage (optional)" /></Field>
              <Field label="Condition operator">
                <select name="cond_op">
                  <option value="eq">equals</option><option value="neq">not equals</option>
                  <option value="in">in list</option><option value="gt">greater than</option>
                </select>
              </Field>
              <Field label="Condition value"><input type="text" name="cond_value" placeholder="manager_review" /></Field>
              <Field label="Action">
                <select name="action_type">
                  <option value="send_message">Send message</option>
                  <option value="create_task">Create task</option>
                  <option value="notify_user">Notify user</option>
                  <option value="log_only">Log only</option>
                </select>
              </Field>
              <Field label="Action title / task name"><input type="text" name="action_title" placeholder="Hiring manager review required" /></Field>
              <Field label="Template ID"><input type="number" name="template_id" placeholder="1" /></Field>
              <Field label="Due in hours"><input type="number" name="due_in_hours" placeholder="48" /></Field>
              <Field label="Description" full><textarea name="description" rows={2} /></Field>
            </div>
            <div class="checkline mt16"><input type="checkbox" name="test_mode" value="true" /> <span>Create in test mode (evaluates but performs no side effects)</span></div>
          </div>
          <footer>
            <button class="btn" type="button" onclick="closeModal('rule-modal')">Cancel</button>
            <button class="btn primary" type="submit">Create rule</button>
          </footer>
        </form>
      </dialog>
    </Layout>
  )
}

export const SettingsPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { users, slas, settings, audit, resumeQueue } = data
  return (
    <Layout user={user} active="/settings" title="Settings">
      <PageHead title="Settings & administration" sub="User administration, SLA thresholds, organisation settings, resume processing and the audit trail." />

      <div class="tabs">
        <a href="#users" class="active">Users</a>
        <a href="#sla">SLA</a>
        <a href="#org">Organisation</a>
        <a href="#processing">Resume processing</a>
        <a href="#audit">Audit trail</a>
      </div>

      <Card title="Users & roles" id="users" tight sub={`${users.length} accounts`} actions={
        <button class="btn sm primary" onclick="openModal('user-modal')"><i class="fa-solid fa-plus"></i> Add user</button>
      }>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Title</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {users.map((u: any) => (
              <tr>
                <td><Person first={u.name.split(' ')[0]} last={u.name.split(' ')[1]} small /></td>
                <td class="small mono">{u.email}</td>
                <td><Badge tone={u.role === 'admin' ? 'violet' : u.role === 'recruiter' ? 'brand' : 'slate'}>{titleCase(u.role)}</Badge></td>
                <td class="small">{u.title || '—'}</td>
                <td>{u.active ? <Badge tone="ok" dot>Active</Badge> : <Badge tone="slate" dot>Inactive</Badge>}</td>
                <td>
                  {u.id !== user.id ? (
                    <button class="btn ghost sm" data-act={`/api/users/${u.id}`} data-method="PATCH" data-body={JSON.stringify({ active: !u.active })} data-reload="1">
                      {u.active ? 'Deactivate' : 'Activate'}
                    </button>
                  ) : <span class="tiny muted">you</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="SLA thresholds" id="sla" tight sub="Hours allowed per stage before an application is overdue" actions={
        <button class="btn sm" data-act="/api/sla/escalate" data-reload="1">Run escalation</button>
      }>
        <table>
          <thead><tr><th>Stage</th><th class="num">Threshold (hours)</th><th>Escalate to</th><th></th></tr></thead>
          <tbody>
            {slas.map((s: any) => (
              <tr>
                <td class="small">{titleCase(s.stage)}</td>
                <td class="num small">{s.threshold_hours}h</td>
                <td class="tiny">{s.escalate_to || '—'}</td>
                <td>
                  <button class="btn ghost sm" data-act={`/api/sla/settings/${s.stage}`} data-method="PATCH" data-prompt={`New threshold in hours for ${s.stage}`} data-reload="1">Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div class="grid g2 mt16">
        <Card title="Organisation" id="org">
          <Meta2 items={[
            ['Organisation', settings.org_name || '—'],
            ['Timezone', settings.timezone || 'UTC'],
            ['Retention', `${settings.retention_months || 24} months`],
            ['Mail provider', settings.mail_provider || 'internal-sim'],
            ['Escalation inbox', settings.sla_escalation_email || '—']
          ]} />
          <div class="spec-note mt16 tiny">
            All timestamps are stored and displayed in UTC. Changing the reporting timezone requires a data migration and is out of scope for this release.
          </div>
        </Card>

        <Card title="Resume processing pipeline" id="processing">
          <div class="grid g3 mb16">
            <div><div class="tiny muted">Failed</div><b>{resumeQueue.failed}</b></div>
            <div><div class="tiny muted">Dead letter</div><b>{resumeQueue.dead}</b></div>
            <div><div class="tiny muted">Pending</div><b>{resumeQueue.pending}</b></div>
          </div>
          <div class="small muted mb16" style="line-height:1.7">
            Uploaded → Malware scan → Queued → Parsing/OCR → Parsed → Screening ready.
            Failures retry up to 3 attempts, then move to dead letter for manual review.
          </div>
          <button class="btn primary" data-act="/api/resumes/drain" data-reload="1"><i class="fa-solid fa-play"></i> Drain queue</button>
        </Card>
      </div>

      <Card title="Audit trail" id="audit" tight sub="Most recent 40 events" actions={
        <a class="btn sm" href="/api/audit/export.csv"><i class="fa-solid fa-file-csv"></i> Export</a>
      }>
        <div class="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Actor</th><th>Entity</th><th>Action</th><th>Previous</th><th>New</th><th>Reason</th></tr></thead>
            <tbody>
              {audit.map((a: any) => (
                <tr>
                  <td class="tiny muted nowrap">{fmtDate(a.created_at)}</td>
                  <td class="small">{a.actor_name || 'System'}</td>
                  <td class="tiny mono">{a.entity_type}:{a.entity_id}</td>
                  <td class="small">{titleCase(a.action)}</td>
                  <td class="tiny">{a.previous_value || '—'}</td>
                  <td class="tiny">{a.new_value || '—'}</td>
                  <td class="tiny muted">{a.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <dialog class="modal" id="user-modal">
        <header><h3>Add user</h3><button class="btn ghost sm" onclick="closeModal('user-modal')"><i class="fa-solid fa-xmark"></i></button></header>
        <form data-api="/api/users" data-method="post" data-reload="1">
          <div class="body">
            <div class="form-grid">
              <Field label="Full name" full><input type="text" name="name" required /></Field>
              <Field label="Email" full><input type="email" name="email" required /></Field>
              <Field label="Role">
                <select name="role">
                  {['recruiter', 'hiring_manager', 'interviewer', 'coordinator', 'admin'].map((r) => <option value={r}>{titleCase(r)}</option>)}
                </select>
              </Field>
              <Field label="Title"><input type="text" name="title" /></Field>
              <Field label="Department"><input type="text" name="department" /></Field>
              <Field label="Password" help="Minimum 8 characters"><input type="password" name="password" required /></Field>
            </div>
          </div>
          <footer>
            <button class="btn" type="button" onclick="closeModal('user-modal')">Cancel</button>
            <button class="btn primary" type="submit">Create user</button>
          </footer>
        </form>
      </dialog>
    </Layout>
  )
}

const Meta2 = ({ items }: { items: [string, string][] }) => (
  <table>
    <tbody>
      {items.map(([k, v]) => (
        <tr><td class="small muted" style="width:150px">{k}</td><td class="small"><b>{v}</b></td></tr>
      ))}
    </tbody>
  </table>
)
