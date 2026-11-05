import { Layout } from '../components/layout'
import {
  PageHead, Card, Stat, Person, Empty, Badge, StageBadge, AppStatus, AgingPill, Timeline,
  Meta, Field, OfferStatus, MsgStatus
} from '../components/ui'
import { fmtDate, fmtDateTime, relTime, titleCase, truncate, money, nowIso, hoursBetween } from '../lib/util'
import { STAGE_ORDER, JOB_TRANSITIONS } from '../lib/lifecycle'
import type { AuthUser } from '../lib/auth'
import { can } from '../lib/rbac'

export const PipelinePage = ({ user, data, jobId }: { user: AuthUser; data: any; jobId?: number }) => {
  const { jobs, rows, aging } = data
  const byStage = (s: string) => rows.filter((r: any) => r.stage === s && r.status === 'active')
  const overdueIds = new Set(aging.overdue.map((o: any) => o.application_id))

  return (
    <Layout user={user} active="/pipeline" title="Pipeline">
      <PageHead
        title="Recruitment pipeline"
        sub="Stage tracking per application. Moving a stage requires a valid transition; multi-stage jumps and rewinds require a recorded reason. Every move writes to the stage history and audit trail."
        actions={
          <form method="get" action="/pipeline" class="row" style="gap:6px">
            <select name="job" style="width:230px">
              <option value="">All requisitions</option>
              {jobs.map((j: any) => <option value={j.id} selected={String(jobId) === String(j.id)}>{j.title} ({j.code})</option>)}
            </select>
            <button class="btn" type="submit">Filter</button>
          </form>
        }
      />

      <div class="grid g5 mb16">
        <Stat label="Active applications" value={rows.filter((r: any) => r.status === 'active').length} />
        <Stat label="In interview" value={byStage('interview').length} />
        <Stat label="On hold" value={rows.filter((r: any) => r.status === 'on_hold').length} />
        <Stat label="Past SLA" value={aging.overdue.length} tone={aging.overdue.length ? 'var(--danger)' : undefined} />
        <Stat label="Hired" value={rows.filter((r: any) => r.status === 'hired').length} />
      </div>

      <Card tight>
        <div class="card-body" style="overflow-x:auto">
          <div class="pipeline">
            {STAGE_ORDER.map((stage) => {
              const items = byStage(stage)
              return (
                <div class="pipe-col">
                  <h4>{titleCase(stage === 'recruiter_review' ? 'Recruiter review' : stage === 'manager_review' ? 'Manager review' : stage)} <span class="n">{items.length}</span></h4>
                  {items.map((a: any) => (
                    <a
                      class={`pipe-card ${overdueIds.has(a.id) ? 'overdue' : ''}`}
                      href={`/applications/${a.id}`}
                      style="display:block;text-decoration:none;color:inherit"
                    >
                      <b>{a.first_name} {a.last_name}</b>
                      <span class="m">{truncate(a.job_title, 22)}</span>
                      <div class="row between" style="margin-top:5px">
                        <span class="tiny muted">{a.experience_years ? `${a.experience_years}y` : ''}</span>
                        <span class="tiny muted">{Math.round(a.hours_in_stage)}h</span>
                      </div>
                    </a>
                  ))}
                  {items.length === 0 ? <div class="tiny muted" style="padding:8px 2px">—</div> : null}
                </div>
              )
            })}
          </div>
        </div>
      </Card>

      <Card title="All applications" tight sub={`${rows.length} records`} >
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Candidate</th><th>Requisition</th><th>Stage</th><th>Status</th><th>Source</th><th>In stage</th><th></th></tr>
            </thead>
            <tbody>
              {rows.slice(0, 80).map((a: any) => (
                <tr>
                  <td><a href={`/candidates/${a.candidate_id}`} style="text-decoration:none;color:inherit"><Person first={a.first_name} last={a.last_name} sub={a.headline} small /></a></td>
                  <td class="small"><a href={`/jobs/${a.job_id}`}>{truncate(a.job_title, 26)}</a></td>
                  <td><StageBadge stage={a.stage} /></td>
                  <td><AppStatus status={a.status} /></td>
                  <td class="tiny">{a.source}</td>
                  <td style="width:96px"><AgingPill hours={a.hours_in_stage} threshold={a.threshold_hours} /></td>
                  <td class="nowrap"><a class="btn sm" href={`/applications/${a.id}`}>Open</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Layout>
  )
}

export const ApplicationDetailPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { app, candidate, job, history, interviews, offers, onboarding, messages, feedbackSummary } = data
  const thresholds: Record<string, number> = { applied: 24, parsing: 6, screening: 48, recruiter_review: 72, manager_review: 48, interview: 120, offer: 72 }
  const hoursInStage = hoursBetween(app.stage_entered_at, nowIso())
  const idx = STAGE_ORDER.indexOf(app.stage as any)
  const nextStage = idx >= 0 && idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1] : null
  const prevStage = idx > 0 ? STAGE_ORDER[idx - 1] : null
  const canMove = can(user.role, 'application.move')

  return (
    <Layout user={user} active="/pipeline" title={`${candidate.first_name} ${candidate.last_name}`}>
      <PageHead
        title={`${candidate.first_name} ${candidate.last_name}`}
        sub={`${job.title} · ${job.code} · applied ${fmtDate(app.applied_at)} · source ${app.source || 'unknown'}`}
        actions={
          <>
            <StageBadge stage={app.stage} />
            <AppStatus status={app.status} />
            <a class="btn" href={`/candidates/${candidate.id}`}><i class="fa-solid fa-user"></i> Profile</a>
            {canMove && nextStage ? (
              <button class="btn primary" data-act={`/api/applications/${app.id}/stage`} data-body={JSON.stringify({ to_stage: nextStage, reason: null })} data-reload="1">
                Advance to {titleCase(nextStage)} <i class="fa-solid fa-arrow-right"></i>
              </button>
            ) : null}
            {canMove && prevStage ? (
              <button class="btn" data-act={`/api/applications/${app.id}/stage`} data-body={JSON.stringify({ to_stage: prevStage })} data-prompt={`Move back to ${titleCase(prevStage)} — reason (required)`} data-reload="1">
                <i class="fa-solid fa-arrow-left"></i> Back
              </button>
            ) : null}
            {can(user.role, 'application.reject') && app.status === 'active' ? (
              <button class="btn danger" data-act={`/api/applications/${app.id}/status`} data-body='{"status":"rejected"}' data-prompt="Rejection reason (recorded for drop-off analytics)" data-reload="1">
                Reject
              </button>
            ) : null}
            {canMove && app.status === 'active' ? (
              <button class="btn" data-act={`/api/applications/${app.id}/status`} data-body='{"status":"on_hold"}' data-prompt="Reason for hold" data-reload="1">Hold</button>
            ) : null}
          </>
        }
      />

      <div class="grid g4 mb16">
        <Stat label="Stage" value={titleCase(app.stage)} meta={nextStage ? `Next: ${titleCase(nextStage)}` : 'Final stage'} />
        <Stat label="Time in stage" value={hoursInStage < 48 ? `${Math.round(hoursInStage)}h` : `${Math.round(hoursInStage / 24)}d`}
          meta={`SLA ${thresholds[app.stage] || 48}h`}
          tone={hoursInStage > (thresholds[app.stage] || 48) ? 'var(--danger)' : undefined} />
        <Stat label="Interviews" value={interviews.length} meta={`${interviews.filter((i: any) => i.status === 'feedback_complete').length} feedback complete`} />
        <Stat label="Offers" value={offers.length} meta={offers[0] ? titleCase(offers[0].status) : 'None raised'} />
      </div>

      <div class="split">
        <div class="stack">
          <Card title="Move stage">
            {!canMove ? <div class="small muted">Your role cannot move applications.</div> : (
              <form data-api={`/api/applications/${app.id}/stage`} data-method="post" data-reload="1">
                <div class="form-grid">
                  <Field label="Target stage">
                    <select name="to_stage">
                      {STAGE_ORDER.filter((s) => s !== app.stage).map((s) => <option value={s}>{titleCase(s)}</option>)}
                    </select>
                  </Field>
                  <Field label="Reason" help="Required for multi-stage jumps and rewinds"><input type="text" name="reason" /></Field>
                </div>
                <button class="btn primary mt16" type="submit">Move application</button>
              </form>
            )}
          </Card>

          <Card title="Stage history" sub="Actor, timestamp, previous and new value" tight>
            {history.length === 0 ? <Empty icon="fa-clock-rotate-left" title="No stage changes" /> : (
              <div class="card-body">
                <Timeline items={history.map((h: any) => ({
                  title: `${titleCase(h.to_stage)}${h.from_stage ? ` ← ${titleCase(h.from_stage)}` : ' (applied)'}`,
                  meta: `${fmtDateTime(h.created_at)} · ${h.actor_name || 'System'}${h.to_status !== 'active' ? ` · ${titleCase(h.to_status)}` : ''}`,
                  tone: h.to_status === 'rejected' ? 'danger' : h.to_status === 'hired' ? 'ok' : h.to_status === 'on_hold' ? 'warn' : '',
                  body: h.reason || null
                }))} />
              </div>
            )}
          </Card>

          <Card title="Interviews" tight actions={can(user.role, 'interview.schedule') ? <a class="btn sm" href={`/interviews/new?application=${app.id}`}><i class="fa-solid fa-plus"></i> Schedule</a> : null}>
            {interviews.length === 0 ? <Empty icon="fa-calendar-xmark" title="No interviews scheduled" /> : (
              <table>
                <thead><tr><th>Round</th><th>When</th><th>Status</th><th>Feedback</th><th></th></tr></thead>
                <tbody>
                  {interviews.map((i: any) => (
                    <tr>
                      <td class="small"><b>{i.title}</b><div class="cell-sub">Round {i.round} · {i.mode}</div></td>
                      <td class="small">{i.scheduled_at ? fmtDateTime(i.scheduled_at) : '—'}</td>
                      <td><Badge tone={i.status === 'feedback_complete' ? 'ok' : i.status === 'feedback_pending' ? 'warn' : i.status === 'cancelled' ? 'danger' : 'info'} dot>{titleCase(i.status)}</Badge></td>
                      <td class="small">{i.feedback_count}/{i.panel_count}</td>
                      <td class="nowrap"><a class="btn sm" href={`/interviews/${i.id}`}>Open</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {feedbackSummary ? (
            <div class="ai-panel">
              <header><i class="fa-solid fa-wand-magic-sparkles" style="color:#7c3aed"></i><b>AI feedback summary</b>
                <span class="badge violet" style="margin-left:auto">assistive</span></header>
              <div class="card-body">
                <p class="small">{feedbackSummary.summary}</p>
                {feedbackSummary.conflicts?.length ? (
                  <div class="warn-note mt8">
                    <b>Conflicts</b>
                    {feedbackSummary.conflicts.map((c: string) => <div class="small">· {c}</div>)}
                  </div>
                ) : null}
                {feedbackSummary.missing_evidence?.length ? (
                  <div class="small muted mt8">
                    <b>Missing evidence</b>
                    {feedbackSummary.missing_evidence.map((m: string) => <div>· {m}</div>)}
                  </div>
                ) : null}
                <div class="row wrap mt8" style="gap:5px">
                  {(feedbackSummary.sources || []).map((s: any) => (
                    <a class="btn sm" href={`/interviews/${s.interview_id}`}>{s.interviewer} · {s.overall}/5</a>
                  ))}
                </div>
                <div class="tiny muted mt8" style="border-top:1px solid #ede9fe;padding-top:8px">
                  Source scorecards are never overwritten — open any interview to read the original feedback.
                </div>
              </div>
            </div>
          ) : null}

          <Card title="Communication history" tight>
            {messages.length === 0 ? <Empty icon="fa-envelope-open" title="No messages" /> : (
              <table>
                <tbody>
                  {messages.map((m: any) => (
                    <tr>
                      <td><div class="small">{truncate(m.subject, 52)}</div><div class="cell-sub">{relTime(m.created_at)}</div></td>
                      <td><MsgStatus status={m.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div class="stack">
          <Card title="Candidate">
            <Person first={candidate.first_name} last={candidate.last_name} sub={candidate.headline} />
            <hr />
            <Meta items={[
              ['Email', <span class="small mono">{candidate.email}</span>],
              ['Phone', <span class="small">{candidate.phone || '—'}</span>],
              ['Location', <span class="small">{candidate.location || '—'}</span>],
              ['Experience', <span class="small">{candidate.experience_years ? `${candidate.experience_years} yrs` : '—'}</span>],
              ['Notice', <span class="small">{candidate.notice_period_days ? `${candidate.notice_period_days} days` : '—'}</span>],
              ['Expected', <span class="small">{candidate.expected_salary ? money(candidate.expected_salary) : '—'}</span>],
              ['Consent', <Badge tone={candidate.consent_status === 'opt_in' ? 'ok' : candidate.consent_status === 'opt_out' ? 'danger' : 'slate'}>{titleCase(candidate.consent_status)}</Badge>]
            ]} />
          </Card>

          <Card title="Requisition">
            <a href={`/jobs/${job.id}`} class="cell-main" style="text-decoration:none">{job.title}</a>
            <div class="cell-sub mono">{job.code}</div>
            <hr />
            <Meta items={[
              ['Location', <span class="small">{job.location}</span>],
              ['Department', <span class="small">{job.department}</span>],
              ['Recruiter', <span class="small">{job.recruiter_name || '—'}</span>],
              ['Manager', <span class="small">{job.manager_name || '—'}</span>]
            ]} />
          </Card>

          {offers.length ? (
            <Card title="Offers" tight>
              {offers.map((o: any) => (
                <div style="padding:12px 14px;border-bottom:1px solid var(--line-soft)">
                  <div class="row between mb8">
                    <b class="small">Version {o.version}</b>
                    <OfferStatus status={o.status} />
                  </div>
                  <div class="small muted">
                    {money(o.base_salary, o.currency)} base · bonus {money(o.bonus, o.currency)}
                    {o.start_date ? ` · start ${fmtDate(o.start_date)}` : ''}
                  </div>
                  <a class="btn sm mt8" href={`/offers/${o.id}`}>Open offer</a>
                </div>
              ))}
            </Card>
          ) : null}

          {onboarding ? (
            <Card title="Onboarding handoff">
              <Badge tone={onboarding.status === 'joined' ? 'ok' : 'info'} dot>{titleCase(onboarding.status)}</Badge>
              <a class="btn sm mt8" href="/onboarding">Open handoff</a>
            </Card>
          ) : null}

          {can(user.role, 'application.create') ? (
            <Card title="Send message">
              <form data-api="/api/messages" data-method="post" data-reload="1">
                <input type="hidden" name="candidate_id" value={candidate.id} />
                <input type="hidden" name="application_id" value={app.id} />
                <Field label="Template">
                  <select name="template_id">
                    <option value="">— custom —</option>
                    {data.templates.map((t: any) => <option value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
                <Field label="Subject"><input type="text" name="subject" placeholder="Optional with template" /></Field>
                <Field label="Body"><textarea name="body" rows={4} placeholder="Leave blank to use the template body" /></Field>
                <button class="btn primary mt8" type="submit"><i class="fa-solid fa-paper-plane"></i> Send</button>
              </form>
            </Card>
          ) : null}
        </div>
      </div>
    </Layout>
  )
}
