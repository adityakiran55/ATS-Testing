import { Layout } from '../components/layout'
import {
  PageHead, Card, Stat, JobStatus, AppStatus, StageBadge, Person, Empty, Bars, FunnelChart,
  AgingPill, SourceTag, Badge, Avatar
} from '../components/ui'
import { fmtDate, relTime, titleCase, pct, truncate } from '../lib/util'
import type { AuthUser } from '../lib/auth'
import { can } from '../lib/rbac'

export const DashboardPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { stats, funnel, aging, jobs, activity, tasks, resumeQueue, dupCount, sources, offers } = data
  const isManager = user.role === 'hiring_manager'
  const isInterviewer = user.role === 'interviewer'

  return (
    <Layout user={user} active="/" title="Dashboard">
      <PageHead
        title={`Good day, ${user.name.split(' ')[0]}`}
        sub={isManager
          ? 'Your assigned requisitions, candidates awaiting your review, and interview panels you sit on.'
          : isInterviewer
            ? 'Your upcoming interviews and scorecards awaiting feedback.'
            : 'Live recruiting health across requisitions, pipeline, SLA compliance and candidate handling.'}
        actions={
          <>
            {can(user.role, 'candidate.search') ? <a class="btn" href="/candidates"><i class="fa-solid fa-magnifying-glass"></i> Talent search</a> : null}
            {can(user.role, 'job.create') ? <a class="btn primary" href="/jobs/new"><i class="fa-solid fa-plus"></i> New requisition</a> : null}
          </>
        }
      />

      <div class="grid g5 mb16">
        <Stat label="Open requisitions" value={stats.open_jobs}
          meta={<>{stats.total_jobs} total · {stats.pending_approval} awaiting approval</>} />
        <Stat label="Active candidates" value={stats.active_applications}
          meta={<>across {stats.jobs_with_apps} requisitions</>} />
        <Stat label="In interview" value={stats.in_interview}
          meta={<>{stats.interviews_this_week} scheduled this week</>} />
        <Stat label="Offers out" value={stats.offers_out}
          meta={<>{stats.offer_accept_rate}% acceptance</>} />
        <Stat label="SLA breaches" value={stats.overdue}
          tone={stats.overdue > 0 ? 'var(--danger)' : undefined}
          meta={stats.overdue > 0 ? <a href="/sla">Review overdue queue →</a> : 'All within SLA'} />
      </div>

      {(resumeQueue.failed > 0 || dupCount > 0 || stats.pending_approval > 0) ? (
        <div class="grid g3 mb16">
          {stats.pending_approval > 0 ? (
            <a href="/jobs?status=pending_approval" style="text-decoration:none;color:inherit">
              <div class="card" style="border-left:3px solid var(--warn)">
                <div class="stat">
                  <div class="label"><i class="fa-solid fa-hourglass-half" style="margin-right:5px"></i>Approvals waiting</div>
                  <div class="value">{stats.pending_approval}</div>
                  <div class="meta">Requisitions need an approver decision</div>
                </div>
              </div>
            </a>
          ) : null}
          {dupCount > 0 ? (
            <a href="/candidates/duplicates" style="text-decoration:none;color:inherit">
              <div class="card" style="border-left:3px solid var(--violet)">
                <div class="stat">
                  <div class="label"><i class="fa-solid fa-clone" style="margin-right:5px"></i>Duplicate review</div>
                  <div class="value">{dupCount}</div>
                  <div class="meta">Candidate pairs flagged for merge review</div>
                </div>
              </div>
            </a>
          ) : null}
          {resumeQueue.failed > 0 ? (
            <a href="/candidates?tab=processing" style="text-decoration:none;color:inherit">
              <div class="card" style="border-left:3px solid var(--danger)">
                <div class="stat">
                  <div class="label"><i class="fa-solid fa-triangle-exclamation" style="margin-right:5px"></i>Resume failures</div>
                  <div class="value">{resumeQueue.failed}</div>
                  <div class="meta">{resumeQueue.dead_letter} in dead letter · retry available</div>
                </div>
              </div>
            </a>
          ) : null}
        </div>
      ) : null}

      <div class="split mb16">
        <Card title="Recruitment funnel" sub={`${stats.period_applications} applications in scope`}
          actions={<a class="btn ghost sm" href="/analytics">Full analytics <i class="fa-solid fa-arrow-right"></i></a>}>
          <FunnelChart funnel={funnel} />
        </Card>

        <div class="stack">
          <Card title="Stage SLA risk" tight actions={<a class="btn ghost sm" href="/sla">Open</a>}>
            {tasks.overdue.length === 0 ? <Empty icon="fa-circle-check" title="No SLA breaches" sub="Every active application is inside its stage threshold." /> : (
              <div class="table-wrap">
                <table>
                  <tbody>
                    {tasks.overdue.slice(0, 5).map((a: any) => (
                      <tr>
                        <td>
                          <div class="cell-main">{a.candidate_name}</div>
                          <div class="cell-sub">{truncate(a.job_title, 26)} · {titleCase(a.stage)}</div>
                        </td>
                        <td class="nowrap"><AgingPill hours={a.hours_in_stage} threshold={a.threshold_hours} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Applications by source">
            <Bars rows={sources.slice(0, 5).map((s: any) => ({ label: s.source, value: s.applications }))} />
          </Card>
        </div>
      </div>

      <div class="grid g2 mb16">
        <Card title="My attention queue" sub={isManager ? 'Awaiting your review' : 'Assigned to you'} tight
          actions={<a class="btn ghost sm" href={isManager ? '/manager' : '/sla'}>View all</a>}>
          {tasks.mine.length === 0 ? <Empty icon="fa-mug-hot" title="Nothing needs you right now" /> : (
            <div class="table-wrap">
              <table>
                <thead><tr><th>Task</th><th>Due</th><th>Status</th></tr></thead>
                <tbody>
                  {tasks.mine.map((t: any) => (
                    <tr>
                      <td><div class="cell-main">{t.title}</div><div class="cell-sub">{t.detail ? truncate(t.detail, 54) : titleCase(t.type)}</div></td>
                      <td class="nowrap small">{t.due_at ? relTime(t.due_at) : '—'}</td>
                      <td><Badge tone={t.status === 'overdue' ? 'danger' : t.status === 'open' ? 'info' : 'ok'} dot>{titleCase(t.status)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Open requisitions" tight actions={<a class="btn ghost sm" href="/jobs">All</a>}>
          {jobs.length === 0 ? <Empty title="No open requisitions" /> : (
            <div class="table-wrap">
              <table>
                <tbody>
                  {jobs.map((j: any) => (
                    <tr>
                      <td>
                        <a href={`/jobs/${j.id}`} class="cell-main" style="text-decoration:none">{j.title}</a>
                        <div class="cell-sub">{j.code} · {j.location} · {j.applications} apps · {j.hires}/{j.openings} filled</div>
                      </td>
                      <td style="width:110px">
                        <div class="tiny muted" style="margin-bottom:3px">{j.days_open}d open</div>
                        <div class={`bar ${j.days_open > 45 ? 'danger' : j.days_open > 30 ? 'warn' : 'ok'}`}>
                          <span style={`width:${Math.min(100, (j.days_open / 60) * 100)}%`}></span>
                        </div>
                      </td>
                      <td class="nowrap"><JobStatus status={j.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div class="grid g2">
        <Card title="Recent activity" sub="Audited state changes" tight>
          {activity.length === 0 ? <Empty title="No activity yet" /> : (
            <div class="table-wrap">
              <table>
                <tbody>
                  {activity.map((a: any) => (
                    <tr>
                      <td style="width:30px"><Avatar first={(a.actor_name || 'S').split(' ')[0]} last={(a.actor_name || '').split(' ')[1] || ''} size={26} /></td>
                      <td>
                        <div class="small">
                          <b>{a.actor_name || 'System'}</b>{' '}
                          <span class="muted">{a.action.replace(/_/g, ' ')}</span>{' '}
                          <span class="mono tiny">{a.entity_type}:{a.entity_id}</span>
                        </div>
                        <div class="cell-sub">
                          {a.previous_value ? `${titleCase(String(a.previous_value))} → ` : ''}
                          {a.new_value ? titleCase(String(a.new_value)) : a.reason || ''}
                        </div>
                      </td>
                      <td class="tiny muted nowrap">{relTime(a.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Offers in flight" tight actions={<a class="btn ghost sm" href="/offers">Manage</a>}>
          {offers.length === 0 ? <Empty icon="fa-file-signature" title="No offers outstanding" /> : (
            <div class="table-wrap">
              <table>
                <thead><tr><th>Candidate</th><th>Role</th><th>Status</th><th class="num">Base</th></tr></thead>
                <tbody>
                  {offers.map((o: any) => (
                    <tr>
                      <td><div class="cell-main">{o.first_name} {o.last_name}</div><div class="cell-sub">v{o.version} · {o.expires_at ? `expires ${fmtDate(o.expires_at)}` : 'no expiry'}</div></td>
                      <td class="small">{truncate(o.job_title, 22)}</td>
                      <td><Badge tone={o.status === 'accepted' ? 'ok' : o.status === 'declined' ? 'danger' : 'info'} dot>{titleCase(o.status)}</Badge></td>
                      <td class="num small">${(o.base_salary || 0).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Layout>
  )
}
