import { Layout } from '../components/layout'
import {
  PageHead, Card, Stat, JobStatus, AppStatus, StageBadge, Person, Empty, Badge, Meta,
  PostingStatus, Field, Select, Avatar, Bars, AgingPill
} from '../components/ui'
import { fmtDate, relTime, titleCase, truncate, money, hoursBetween, nowIso } from '../lib/util'
import { STAGE_ORDER, JOB_TRANSITIONS } from '../lib/lifecycle'
import type { AuthUser } from '../lib/auth'
import { can } from '../lib/rbac'

const STATUS_FILTERS = [
  ['', 'All'], ['open', 'Open'], ['pending_approval', 'Pending approval'], ['draft', 'Draft'],
  ['approved', 'Approved'], ['paused', 'Paused'], ['filled', 'Filled'], ['closed', 'Closed'], ['cancelled', 'Cancelled']
]

export const JobsPage = ({ user, data, filters }: { user: AuthUser; data: any; filters: any }) => (
  <Layout user={user} active="/jobs" title="Requisitions">
    <PageHead
      title="Requisitions"
      sub="Requisition intake, approval workflow and status tracking. Every state change is validated against the requisition transition table and recorded in the audit trail."
      actions={can(user.role, 'job.create') ? <a class="btn primary" href="/jobs/new"><i class="fa-solid fa-plus"></i> New requisition</a> : null}
    />

    <div class="grid g5 mb16">
      <Stat label="Open" value={data.byStatus.open || 0} />
      <Stat label="Pending approval" value={data.byStatus.pending_approval || 0} />
      <Stat label="Draft" value={data.byStatus.draft || 0} />
      <Stat label="Paused" value={data.byStatus.paused || 0} />
      <Stat label="Filled" value={data.byStatus.filled || 0} />
    </div>

    <Card tight>
      <div class="row wrap" style="padding:12px 14px;border-bottom:1px solid var(--line-soft);gap:6px">
        {STATUS_FILTERS.map(([v, l]) => (
          <a class={`btn sm ${(filters.status || '') === v ? 'primary' : ''}`} href={`/jobs${v ? `?status=${v}` : ''}`}>{l}</a>
        ))}
        <div style="flex:1"></div>
        <form class="row" method="get" action="/jobs" style="gap:6px">
          {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
          <input type="text" name="q" placeholder="Search title, code, location" value={filters.q || ''} style="width:220px" />
          <button class="btn sm" type="submit"><i class="fa-solid fa-magnifying-glass"></i></button>
        </form>
      </div>

      {data.jobs.length === 0 ? <Empty icon="fa-briefcase" title="No requisitions match" sub="Adjust the filters or create a new requisition." /> : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Requisition</th>
                <th>Status</th>
                <th>Owner</th>
                <th class="num">Apps</th>
                <th class="num">Filled</th>
                <th>Aging</th>
                <th class="num">Postings</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((j: any) => (
                <tr>
                  <td>
                    <a href={`/jobs/${j.id}`} class="cell-main" style="text-decoration:none">{j.title}</a>
                    <div class="cell-sub">
                      <span class="mono">{j.code}</span> · {j.location} · {titleCase(j.work_mode)} · {titleCase(j.department)}
                    </div>
                  </td>
                  <td><JobStatus status={j.status} /></td>
                  <td class="small">
                    <div>{j.recruiter_name || '—'}</div>
                    <div class="cell-sub">HM: {j.manager_name || '—'}</div>
                  </td>
                  <td class="num">{j.applications}<div class="cell-sub">{j.active} active</div></td>
                  <td class="num">{j.hires}/{j.openings}</td>
                  <td style="width:100px">
                    {j.opened_at ? <AgingPill hours={Math.round((j.days_open || 0) * 24)} threshold={45 * 24} /> : <span class="muted tiny">Not open</span>}
                  </td>
                  <td class="num small">{j.live_postings || 0}</td>
                  <td class="nowrap"><a class="btn sm" href={`/jobs/${j.id}`}>Open</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  </Layout>
)

export const NewJobPage = ({ user, users }: { user: AuthUser; users: any[] }) => (
  <Layout user={user} active="/jobs" title="New requisition">
    <PageHead title="New requisition" sub="Create a requisition in Draft. Submit for approval when the brief is complete — approvals follow the workflow, and the requisition cannot open until approved." />

    <form data-api="/api/jobs" data-method="post" data-redirect="/jobs/{id}">
      <div class="split">
        <div class="stack">
          <Card title="Role details">
            <div class="form-grid">
              <Field label="Job title" full><input type="text" name="title" required placeholder="Senior Frontend Engineer" /></Field>
              <Field label="Requisition code" help="Auto-generated if left blank"><input type="text" name="code" placeholder="ENG-1052" /></Field>
              <Field label="Department"><input type="text" name="department" required placeholder="Engineering" /></Field>
              <Field label="Location"><input type="text" name="location" required placeholder="Berlin, Germany" /></Field>
              <Field label="Work mode">
                <select name="work_mode">
                  <option value="onsite">Onsite</option>
                  <option value="hybrid" selected>Hybrid</option>
                  <option value="remote">Remote</option>
                </select>
              </Field>
              <Field label="Employment type">
                <select name="employment_type">
                  <option value="full_time" selected>Full time</option>
                  <option value="contract">Contract</option>
                  <option value="part_time">Part time</option>
                  <option value="intern">Intern</option>
                </select>
              </Field>
              <Field label="Seniority"><input type="text" name="seniority" placeholder="senior" /></Field>
              <Field label="Openings"><input type="number" name="openings" value="1" min="1" /></Field>
              <Field label="Salary min"><input type="number" name="salary_min" placeholder="95000" /></Field>
              <Field label="Salary max"><input type="number" name="salary_max" placeholder="125000" /></Field>
              <Field label="Target fill date"><input type="date" name="target_fill_date" /></Field>
              <Field label="Priority">
                <select name="priority">
                  <option value="low">Low</option>
                  <option value="normal" selected>Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </Field>
              <Field label="Recruiter" full>
                <select name="recruiter_id">
                  <option value="">Unassigned</option>
                  {users.filter((u) => ['recruiter', 'admin'].includes(u.role)).map((u) => (
                    <option value={u.id} selected={u.id === user.id}>{u.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Hiring manager" full>
                <select name="hiring_manager_id">
                  <option value="">Unassigned</option>
                  {users.filter((u) => ['hiring_manager', 'admin'].includes(u.role)).map((u) => (
                    <option value={u.id}>{u.name}</option>
                  ))}
                </select>
              </Field>
            </div>
          </Card>

          <Card title="Job description & requirements">
            <div class="stack">
              <Field label="Description" full>
                <textarea name="description" rows={5} placeholder="What the role involves, team context, ways of working…" />
              </Field>
              <Field label="Requirements" full>
                <textarea name="requirements" rows={4} placeholder="Experience expectations, qualifications…" />
              </Field>
              <Field label="Must-have skills" full help="Comma separated. These drive AI matching criteria and screening scorecards.">
                <input type="text" name="must_have_skills" placeholder="TypeScript, React, GraphQL" />
              </Field>
              <Field label="Nice-to-have skills" full help="Comma separated">
                <input type="text" name="nice_to_have" placeholder="Next.js, Design Systems" />
              </Field>
            </div>
          </Card>
        </div>

        <div class="stack">
          <Card title="Lifecycle">
            <div class="small muted" style="line-height:1.7">
              <div><Badge tone="slate" dot>Draft</Badge> → <Badge tone="info" dot>Submitted</Badge> → <Badge tone="warn" dot>Pending approval</Badge> → <Badge tone="brand" dot>Approved</Badge> → <Badge tone="ok" dot>Open</Badge></div>
              <p class="mt8">New requisitions start in <b>Draft</b>. Job distribution and candidate applications are blocked until the requisition is <b>Open</b>.</p>
            </div>
          </Card>
          <Card title="Create">
            <p class="small muted">The requisition is created in Draft so the brief can be completed before it enters approval.</p>
            <button class="btn primary" type="submit" style="width:100%;justify-content:center">
              <i class="fa-solid fa-plus"></i> Create requisition
            </button>
          </Card>
        </div>
      </div>
    </form>
  </Layout>
)

export const JobDetailPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { job, applications, stageSummary, postings, approvals, audit } = data
  const transitions = (JOB_TRANSITIONS[job.status] || []).filter((t) => can(user.role, t.perm))
  const active = applications.filter((a: any) => a.status === 'active')

  return (
    <Layout user={user} active="/jobs" title={job.title}>
      <PageHead
        title={job.title}
        sub={`${job.code} · ${job.department} · ${job.location} · ${titleCase(job.work_mode)} · ${job.openings} opening${job.openings > 1 ? 's' : ''}`}
        actions={
          <>
            <JobStatus status={job.status} />
            {transitions.map((t) => (
              <button
                class={`btn ${t.to === 'open' || t.to === 'approved' ? 'primary' : t.to === 'cancelled' ? 'danger' : ''}`}
                data-act={`/api/jobs/${job.id}/transition`}
                data-body={JSON.stringify({ to: t.to })}
                data-prompt={t.requiresReason ? `${t.label} — reason (required)` : undefined}
                data-reload="1"
              >
                {t.label}
              </button>
            ))}
            {can(user.role, 'application.create') && job.status === 'open' ? (
              <a class="btn" href={`/jobs/${job.id}/add-candidate`}><i class="fa-solid fa-user-plus"></i> Add candidate</a>
            ) : null}
          </>
        }
      />

      <div class="grid g5 mb16">
        <Stat label="Applications" value={applications.length} meta={`${active.length} active`} />
        <Stat label="In interview" value={stageSummary.find((s: any) => s.stage === 'interview')?.count || 0} />
        <Stat label="Hires" value={`${data.hires}/${job.openings}`} meta={data.hires >= job.openings ? 'Filled' : 'Still open'} />
        <Stat label="Days open" value={job.opened_at ? job.days_open : 0} meta={job.opened_at ? `Since ${fmtDate(job.opened_at)}` : 'Not opened'} />
        <Stat label="Live postings" value={postings.filter((p: any) => p.status === 'published').length} meta={`${postings.length} channels configured`} />
      </div>

      <div class="split mb16">
        <Card title="Pipeline snapshot" actions={<a class="btn ghost sm" href={`/pipeline?job=${job.id}`}>Open pipeline</a>}>
          <div class="pipeline">
            {stageSummary.map((s: any) => (
              <div class="pipe-col">
                <h4>{titleCase(s.stage)} <span class="n">{s.count}</span></h4>
                {applications.filter((a: any) => a.stage === s.stage && a.status === 'active').slice(0, 4).map((a: any) => (
                  <a class="pipe-card" href={`/candidates/${a.candidate_id}`} style="display:block;text-decoration:none;color:inherit">
                    <b>{a.first_name} {a.last_name}</b>
                    <span class="m">{a.experience_years ? `${a.experience_years}y exp` : ''} {a.location ? `· ${truncate(a.location, 16)}` : ''}</span>
                  </a>
                ))}
                {s.count === 0 ? <div class="tiny muted" style="padding:6px 2px">Empty</div> : null}
              </div>
            ))}
          </div>
        </Card>

        <div class="stack">
          <Card title="Role brief">
            <p class="small" style="line-height:1.6">{job.description || 'No description yet.'}</p>
            <hr />
            <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-bottom:5px">Must have</div>
            <div>{job.must_have.map((s: string) => <span class="skill">{s}</span>)}</div>
            {job.nice_to_have.length ? (
              <>
                <div class="tiny muted mt8" style="text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-bottom:5px">Nice to have</div>
                <div>{job.nice_to_have.map((s: string) => <span class="tag">{s}</span>)}</div>
              </>
            ) : null}
            <hr />
            <Meta items={[
              ['Recruiter', job.recruiter_name || '—'],
              ['Hiring manager', job.manager_name || '—'],
              ['Compensation', `${money(job.salary_min, job.currency)} – ${money(job.salary_max, job.currency)}`],
              ['Priority', <Badge tone={job.priority === 'urgent' ? 'danger' : job.priority === 'high' ? 'warn' : 'slate'}>{titleCase(job.priority)}</Badge>],
              ['Target fill', job.target_fill_date ? fmtDate(job.target_fill_date) : '—'],
              ['Created', fmtDate(job.created_at)]
            ]} />
          </Card>

          <Card title="Approval trail" tight>
            {approvals.length === 0 ? <Empty icon="fa-stamp" title="No approval decisions yet" /> : (
              <table>
                <tbody>
                  {approvals.map((a: any) => (
                    <tr>
                      <td>
                        <div class="cell-main">{a.actor_name || 'Approver'}</div>
                        <div class="cell-sub">{a.reason || '—'}</div>
                      </td>
                      <td><Badge tone={a.decision === 'approved' ? 'ok' : a.decision === 'rejected' ? 'danger' : 'warn'}>{titleCase(a.decision)}</Badge></td>
                      <td class="tiny muted nowrap">{fmtDate(a.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>

      <div class="grid g2 mb16">
        <Card title="Distribution status" tight sub={`${postings.filter((p: any) => p.status === 'published').length} published`}
          actions={<a class="btn ghost sm" href={`/distribution?job=${job.id}`}>Manage</a>}>
          {postings.length === 0 ? <Empty icon="fa-bullhorn" title="Not distributed" sub="Publish this requisition to channels." /> : (
            <table>
              <thead><tr><th>Channel</th><th>Status</th><th>Posted</th><th></th></tr></thead>
              <tbody>
                {postings.map((p: any) => (
                  <tr>
                    <td><div class="cell-main">{p.channel_name}</div><div class="cell-sub">{p.api_supported ? 'API supported' : 'Manual export only'}</div></td>
                    <td><PostingStatus status={p.status} /></td>
                    <td class="tiny muted">{p.posted_at ? fmtDate(p.posted_at) : '—'}</td>
                    <td class="nowrap">
                      {p.status === 'failed' ? (
                        <button class="btn sm" data-act={`/api/postings/${p.id}/retry`} data-reload="1">Retry</button>
                      ) : p.status === 'published' ? (
                        <button class="btn sm ghost" data-act={`/api/postings/${p.id}/withdraw`} data-reload="1">Withdraw</button>
                      ) : (
                        <button class="btn sm" data-act={`/api/postings/${p.id}/publish`} data-reload="1">Publish</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Applications" tight sub={`${applications.length} total`}>
          {applications.length === 0 ? <Empty icon="fa-users" title="No applications yet" /> : (
            <div class="table-wrap">
              <table>
                <thead><tr><th>Candidate</th><th>Stage</th><th>Status</th><th>Source</th><th>Applied</th></tr></thead>
                <tbody>
                  {applications.slice(0, 12).map((a: any) => (
                    <tr>
                      <td><Person first={a.first_name} last={a.last_name} sub={a.headline} small /></td>
                      <td><StageBadge stage={a.stage} /></td>
                      <td><AppStatus status={a.status} /></td>
                      <td class="tiny">{a.source}</td>
                      <td class="tiny muted nowrap">{relTime(a.applied_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title="Requisition audit trail" tight>
        {audit.length === 0 ? <Empty icon="fa-clock-rotate-left" title="No audit events" /> : (
          <table>
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Previous</th><th>New</th><th>Reason</th></tr></thead>
            <tbody>
              {audit.map((a: any) => (
                <tr>
                  <td class="tiny muted nowrap">{fmtDate(a.created_at)}</td>
                  <td class="small">{a.actor_name || 'System'}</td>
                  <td class="small">{titleCase(a.action)}</td>
                  <td class="tiny">{a.previous_value || '—'}</td>
                  <td class="tiny">{a.new_value || '—'}</td>
                  <td class="tiny muted">{a.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Layout>
  )
}

export const AddCandidatePage = ({ user, job, candidates }: { user: AuthUser; job: any; candidates: any[] }) => (
  <Layout user={user} active="/jobs" title="Add candidate">
    <PageHead title={`Add candidate to ${job.title}`} sub="Creates an application for an existing candidate, or a new candidate profile. Duplicate detection runs before insert." />
    <div class="split">
      <Card title="Add application">
        <div class="stack">
          <div>
            <label class="field">Existing candidate</label>
            <select id="existing-candidate">
              <option value="">— create new —</option>
              {candidates.map((c) => (
                <option value={c.id}>{c.first_name} {c.last_name} · {c.email}</option>
              ))}
            </select>
          </div>
          <hr />
          <form data-api={`/api/jobs/${job.id}/applications`} data-method="post" data-redirect="/jobs/{id}">
            <div class="form-grid">
              <Field label="Candidate ID" help="Pick from above or leave blank to create a new profile">
                <input type="text" name="candidate_id" id="candidate-id-input" placeholder="(new candidate)" />
              </Field>
              <Field label="Source">
                <select name="source">
                  {['LinkedIn', 'Referral', 'Careers site', 'Agency', 'Job board', 'Talent pool', 'Event', 'Sourced'].map((s) => <option>{s}</option>)}
                </select>
              </Field>
              <Field label="First name"><input type="text" name="first_name" /></Field>
              <Field label="Last name"><input type="text" name="last_name" /></Field>
              <Field label="Email"><input type="email" name="email" /></Field>
              <Field label="Phone"><input type="text" name="phone" /></Field>
              <Field label="Resume text (paste)" full>
                <textarea name="resume_text" rows={6} placeholder="Paste resume text — it will be parsed asynchronously through the resume pipeline." />
              </Field>
            </div>
            <button class="btn primary mt16" type="submit"><i class="fa-solid fa-plus"></i> Create application</button>
          </form>
        </div>
      </Card>
      <Card title="How this works">
        <ul class="small muted" style="line-height:1.8;padding-left:18px">
          <li>The application is created at stage <b>Applied</b> with status <b>Active</b>.</li>
          <li>Pasted resume text enters the pipeline: malware scan → queued → parsing → parsed → screening ready.</li>
          <li>Duplicate detection compares normalised email, phone, name and resume similarity.</li>
          <li><b>application.created</b> fires the automation engine (acknowledgement, tasks).</li>
        </ul>
      </Card>
    </div>
    <script dangerouslySetInnerHTML={{ __html: `
      document.getElementById('existing-candidate').addEventListener('change', function(){
        document.getElementById('candidate-id-input').value = this.value;
      });
    ` }} />
  </Layout>
)
