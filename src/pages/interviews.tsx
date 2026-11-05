import { Layout } from '../components/layout'
import {
  PageHead, Card, Stat, Person, Empty, Badge, Field, Meta, AiBadge, Confidence
} from '../components/ui'
import { fmtDate, fmtDateTime, relTime, titleCase, truncate, nowIso, hoursBetween } from '../lib/util'
import { STAGE_ORDER } from '../lib/lifecycle'
import type { AuthUser } from '../lib/auth'
import { can } from '../lib/rbac'

export const InterviewsPage = ({ user, data, filter }: { user: AuthUser; data: any; filter: string }) => {
  const { interviews, counts } = data
  const tabs = [
    ['', 'All'], ['scheduled', 'Scheduled'], ['confirmed', 'Confirmed'], ['completed', 'Completed'],
    ['feedback_pending', 'Feedback pending'], ['feedback_complete', 'Feedback complete'], ['cancelled', 'Cancelled']
  ]

  return (
    <Layout user={user} active="/interviews" title="Interviews">
      <PageHead
        title="Interviews"
        sub="Scheduling, interviewer assignment, scorecards and feedback. Feedback is required before a hiring decision can proceed, unless an authorised exception is recorded with a reason."
        actions={can(user.role, 'interview.schedule') ? <a class="btn primary" href="/interviews/new"><i class="fa-solid fa-plus"></i> Schedule interview</a> : null}
      />

      <div class="grid g4 mb16">
        <Stat label="Upcoming" value={(counts.scheduled || 0) + (counts.confirmed || 0)} meta="Scheduled or confirmed" />
        <Stat label="Feedback pending" value={counts.feedback_pending || 0} meta="Awaiting scorecards" tone={counts.feedback_pending ? 'var(--warn)' : undefined} />
        <Stat label="Completed" value={counts.feedback_complete || 0} meta="Feedback submitted" />
        <Stat label="Cancelled" value={counts.cancelled || 0} />
      </div>

      <div class="tabs">
        {tabs.map(([v, l]) => (
          <a href={`/interviews${v ? `?status=${v}` : ''}`} class={filter === v ? 'active' : ''}>
            {l}{v && counts[v] ? <span class="n">{counts[v]}</span> : null}
          </a>
        ))}
      </div>

      <Card tight>
        {interviews.length === 0 ? <Empty icon="fa-calendar-xmark" title="No interviews" sub="Schedule an interview from an application." /> : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>Candidate</th><th>Requisition</th><th>Round</th><th>When</th><th>Panel</th><th>Feedback</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {interviews.map((i: any) => (
                  <tr>
                    <td><a href={`/candidates/${i.candidate_id}`} style="text-decoration:none;color:inherit"><Person first={i.first_name} last={i.last_name} sub={i.email} small /></a></td>
                    <td class="small"><a href={`/jobs/${i.job_id}`}>{truncate(i.job_title, 24)}</a></td>
                    <td class="small"><b>{i.title}</b><div class="cell-sub">R{i.round} · {titleCase(i.mode)}</div></td>
                    <td class="small nowrap">{i.scheduled_at ? fmtDateTime(i.scheduled_at) : '—'}</td>
                    <td class="small">{i.panel_count}</td>
                    <td>
                      {i.outstanding_feedback > 0 ? (
                        <Badge tone="warn" dot>{i.outstanding_feedback} outstanding</Badge>
                      ) : (
                        <Badge tone="ok" dot>{i.feedback_count}/{i.panel_count}</Badge>
                      )}
                    </td>
                    <td><Badge tone={i.status === 'feedback_complete' ? 'ok' : i.status === 'feedback_pending' ? 'warn' : i.status === 'cancelled' ? 'danger' : 'info'} dot>{titleCase(i.status)}</Badge></td>
                    <td class="nowrap"><a class="btn sm" href={`/interviews/${i.id}`}>Open</a></td>
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

export const NewInterviewPage = ({ user, users, applications, preselect }: {
  user: AuthUser; users: any[]; applications: any[]; preselect?: number
}) => (
  <Layout user={user} active="/interviews" title="Schedule interview">
    <PageHead title="Schedule interview" sub="Interviews move Draft → Scheduled → Confirmed → Completed → Feedback pending → Feedback complete → Decision. Reschedules and cancellations are logged." />
    <div class="split">
      <Card title="Interview details">
        <form data-api="/api/interviews" data-method="post" data-redirect="/interviews/{id}">
          <div class="form-grid">
            <Field label="Application" full>
              <select name="application_id" required>
                <option value="">Select an active application…</option>
                {applications.map((a) => (
                  <option value={a.id} selected={preselect === a.id}>
                    {a.first_name} {a.last_name} — {a.job_title} ({titleCase(a.stage)})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Title"><input type="text" name="title" value="Technical screen" required /></Field>
            <Field label="Round"><input type="number" name="round" value="1" min="1" /></Field>
            <Field label="Mode">
              <select name="mode">
                <option value="video">Video</option>
                <option value="phone">Phone</option>
                <option value="onsite">Onsite</option>
              </select>
            </Field>
            <Field label="Duration (minutes)"><input type="number" name="duration_min" value="45" min="15" step="15" /></Field>
            <Field label="Scheduled at" full><input type="datetime-local" name="scheduled_at" required /></Field>
            <Field label="Meeting link"><input type="text" name="meeting_link" placeholder="https://meet.example.com/..." /></Field>
            <Field label="Location"><input type="text" name="location" placeholder="Remote / Room 4B" /></Field>
            <Field label="Interviewers" full help="Hold Ctrl/Cmd to select multiple panel members">
              <select name="interviewers" multiple size={5}>
                {users.filter((u) => ['interviewer', 'hiring_manager', 'recruiter'].includes(u.role)).map((u) => (
                  <option value={u.id}>{u.name} — {titleCase(u.role)}</option>
                ))}
              </select>
            </Field>
          </div>
          <button class="btn primary mt16" type="submit"><i class="fa-solid fa-calendar-plus"></i> Schedule</button>
        </form>
      </Card>
      <Card title="Enforcement rules">
        <ul class="small muted" style="line-height:1.85;padding-left:18px">
          <li>Interviewers must submit a scorecard before a decision can be recorded.</li>
          <li>Missing feedback blocks stage advancement out of <b>Interview</b>.</li>
          <li>An authorised exception requires a written reason and is audited.</li>
          <li>Reschedule and cancel actions are recorded against the interview.</li>
        </ul>
      </Card>
    </div>
  </Layout>
)

export const InterviewDetailPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { interview: iv, panel, feedback, users, myFeedback } = data
  const criteria = iv.criteria || []
  const submitted = feedback.filter((f: any) => f.status === 'submitted')
  const canSubmit = can(user.role, 'interview.feedback.submit')

  return (
    <Layout user={user} active="/interviews" title={iv.title}>
      <PageHead
        title={`${iv.title} — ${iv.first_name} ${iv.last_name}`}
        sub={`${iv.job_title} (${iv.job_code}) · Round ${iv.round} · ${titleCase(iv.mode)} · ${iv.scheduled_at ? fmtDateTime(iv.scheduled_at) : 'not scheduled'}`}
        actions={
          <>
            <Badge tone={iv.status === 'feedback_complete' ? 'ok' : iv.status === 'feedback_pending' ? 'warn' : iv.status === 'cancelled' ? 'danger' : 'info'} dot>{titleCase(iv.status)}</Badge>
            {iv.status === 'scheduled' && can(user.role, 'interview.schedule') ? (
              <button class="btn" data-act={`/api/interviews/${iv.id}/status`} data-body='{"to":"confirmed"}' data-reload="1">Confirm</button>
            ) : null}
            {['scheduled', 'confirmed'].includes(iv.status) && can(user.role, 'interview.schedule') ? (
              <>
                <button class="btn" data-act={`/api/interviews/${iv.id}/status`} data-body='{"to":"completed"}' data-reload="1">Mark completed</button>
                <button class="btn danger" data-act={`/api/interviews/${iv.id}/status`} data-body='{"to":"cancelled"}' data-prompt="Cancellation reason (recorded)" data-reload="1">Cancel</button>
              </>
            ) : null}
            <a class="btn" href={`/applications/${iv.app_id}`}>Application</a>
            <a class="btn" href={`/candidates/${iv.candidate_id}`}>Candidate</a>
          </>
        }
      />

      <div class="grid g4 mb16">
        <Stat label="Panel size" value={panel.length} meta={panel.map((p: any) => p.name).join(', ') || 'No panel'} />
        <Stat label="Feedback submitted" value={`${submitted.length}/${panel.length}`} tone={submitted.length < panel.length ? 'var(--warn)' : undefined} />
        <Stat label="Feedback due" value={iv.feedback_due_at ? relTime(iv.feedback_due_at) : '—'} meta={iv.feedback_due_at ? fmtDate(iv.feedback_due_at) : ''} />
        <Stat label="Scorecard" value={iv.scorecard_name || 'None'} meta={criteria.length ? `${criteria.length} criteria` : 'Free-form'} />
      </div>

      <div class="split">
        <div class="stack">
          <Card title="Interviewer feedback" tight>
            {feedback.length === 0 ? <Empty icon="fa-clipboard" title="No feedback yet" /> : (
              <div class="card-body stack">
                {feedback.map((f: any) => (
                  <div style="border:1px solid var(--line);border-radius:9px;padding:12px">
                    <div class="row between mb8">
                      <div class="row" style="gap:8px">
                        <b class="small">{f.interviewer_name}</b>
                        <Badge tone={f.status === 'submitted' ? 'ok' : 'slate'}>{titleCase(f.status)}</Badge>
                      </div>
                      <div class="row" style="gap:6px">
                        <Badge tone={['strong_yes', 'yes'].includes(f.recommendation) ? 'ok' : f.recommendation === 'mixed' ? 'warn' : 'danger'}>
                          {titleCase(f.recommendation || '—')}
                        </Badge>
                        <span class="badge slate">{f.overall ?? '—'}/5</span>
                      </div>
                    </div>
                    {f.scores.length ? (
                      <table style="margin-bottom:8px">
                        <tbody>
                          {f.scores.map((s: any) => (
                            <tr>
                              <td class="small" style="padding:5px 0;width:140px">{titleCase(s.criterion)}</td>
                              <td style="padding:5px 8px;width:70px">
                                <div class="bar" style="width:52px"><span style={`width:${(s.score / 5) * 100}%`}></span></div>
                              </td>
                              <td class="small muted" style="padding:5px 0">{s.note || ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : null}
                    {f.evidence ? <div class="evidence"><div class="src">evidence</div>{f.evidence}</div> : (
                      <div class="warn-note small">No substantive evidence recorded.</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {canSubmit ? (
            <Card title={myFeedback ? 'Your scorecard (resubmit)' : 'Submit your scorecard'}>
              <form data-api={`/api/interviews/${iv.id}/feedback`} data-method="post" data-reload="1">
                <div class="score-grid">
                  {(criteria.length ? criteria : [{ key: 'overall', label: 'Overall assessment', description: 'General suitability' }]).map((c: any) => (
                    <div class="score-row">
                      <div>
                        <b class="small">{c.label}</b>
                        <div class="tiny muted">{c.description}</div>
                      </div>
                      <div>
                        <select name={`score_${c.key}`} style="margin-bottom:4px">
                          {[1, 2, 3, 4, 5].map((n) => (
                            <option value={n} selected={(myFeedback?.scores || []).find((s: any) => s.criterion === c.key)?.score === n}>{n}</option>
                          ))}
                        </select>
                        <input type="text" name={`note_${c.key}`} placeholder="Evidence note" style="font-size:11px"
                          value={(myFeedback?.scores || []).find((s: any) => s.criterion === c.key)?.note || ''} />
                      </div>
                    </div>
                  ))}
                </div>
                <div class="form-grid mt16">
                  <Field label="Overall rating (1–5)">
                    <select name="overall">
                      {[1, 2, 3, 4, 5].map((n) => <option value={n} selected={myFeedback?.overall === n}>{n}</option>)}
                    </select>
                  </Field>
                  <Field label="Recommendation">
                    <select name="recommendation">
                      {['strong_yes', 'yes', 'mixed', 'no', 'strong_no'].map((r) => (
                        <option value={r} selected={myFeedback?.recommendation === r}>{titleCase(r)}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Evidence & comments" full help="Specific examples strengthen the record and are required for enforcement">
                    <textarea name="evidence" rows={4} placeholder="Concrete observations, examples, trade-offs discussed…">{myFeedback?.evidence || ''}</textarea>
                  </Field>
                </div>
                <button class="btn primary mt16" type="submit"><i class="fa-solid fa-check"></i> Submit feedback</button>
              </form>
            </Card>
          ) : null}

          <Card title="Decision gate">
            <div class="row between mb8">
              <div>
                <b class="small">Feedback completeness</b>
                <div class="tiny muted">{submitted.length} of {panel.length} scorecards submitted</div>
              </div>
              {submitted.length >= panel.length ? <Badge tone="ok" dot>Complete</Badge> : <Badge tone="warn" dot>Blocked</Badge>}
            </div>
            <div class="bar mb16"><span style={`width:${panel.length ? (submitted.length / panel.length) * 100 : 0}%`}></span></div>
            {submitted.length < panel.length ? (
              <div class="warn-note">
                A hiring decision cannot be recorded until all panel scorecards are submitted.
                {can(user.role, 'offer.create') ? (
                  <div class="mt8">
                    <button class="btn sm" data-act={`/api/interviews/${iv.id}/exception`} data-prompt="Exception reason (audited, required)" data-reload="1">
                      Record authorised exception
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div class="spec-note">All panel feedback is in. This interview can proceed to decision.</div>
            )}
            <hr />
            <Meta items={[
              ['Created', fmtDate(iv.created_at)],
              ['Completed', iv.completed_at ? fmtDate(iv.completed_at) : '—'],
              ['Cancelled reason', iv.cancelled_reason || '—']
            ]} />
          </Card>
        </div>

        <div class="stack">
          <Card title="Panel" tight>
            <table>
              <tbody>
                {panel.map((p: any) => {
                  const fb = feedback.find((f: any) => f.interviewer_id === p.user_id)
                  return (
                    <tr>
                      <td><Person first={p.name.split(' ')[0]} last={p.name.split(' ')[1]} sub={titleCase(p.role)} small /></td>
                      <td>{fb && fb.status === 'submitted' ? <Badge tone="ok" dot>Submitted</Badge> : <Badge tone="slate" dot>Pending</Badge>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>

          <Card title="Interview log">
            <Meta items={[
              ['Scheduled', iv.scheduled_at ? fmtDateTime(iv.scheduled_at) : '—'],
              ['Duration', `${iv.duration_min} min`],
              ['Mode', titleCase(iv.mode)],
              ['Location', iv.location || '—']
            ]} />
            {iv.meeting_link ? <p class="small mt16"><a href={iv.meeting_link}>{iv.meeting_link}</a></p> : null}
          </Card>
        </div>
      </div>
    </Layout>
  )
}
