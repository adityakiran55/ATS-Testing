import { Layout } from '../components/layout'
import { PageHead, Card, Stat, Empty, Badge, FunnelChart, Bars, Meta, Field } from '../components/ui'
import { titleCase, pct, money, fmtDate } from '../lib/util'
import { METRIC_DEFS } from '../lib/metrics'
import type { AuthUser } from '../lib/auth'

export const AnalyticsPage = ({ user, data, filters }: { user: AuthUser; data: any; filters: any }) => {
  const { analytics, jobs, sources, insights, trend } = data
  const m = analytics.metrics
  const d = analytics.denominators

  return (
    <Layout user={user} active="/analytics" title="Analytics">
      <PageHead
        title="Recruitment funnel & source analytics"
        sub="Every metric has one documented definition, a stated numerator and denominator, and UTC-normalised timestamps. Exports use exactly the same filters as the displayed report."
        actions={
          <a class="btn" href={`/api/analytics/export.csv?${new URLSearchParams(filters as any).toString()}`}>
            <i class="fa-solid fa-file-csv"></i> Export CSV
          </a>
        }
      />

      <form method="get" action="/analytics" class="card mb16" style="padding:14px">
        <div class="form-grid" style="grid-template-columns:repeat(5,minmax(0,1fr))">
          <Field label="From"><input type="date" name="from" value={filters.from || ''} /></Field>
          <Field label="To"><input type="date" name="to" value={filters.to || ''} /></Field>
          <Field label="Requisition">
            <select name="jobId">
              <option value="">All requisitions</option>
              {jobs.map((j: any) => <option value={j.id} selected={String(filters.jobId) === String(j.id)}>{j.title}</option>)}
            </select>
          </Field>
          <Field label="Source">
            <select name="source">
              <option value="">All sources</option>
              {sources.map((s: string) => <option value={s} selected={filters.source === s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Location"><input type="text" name="location" value={filters.location || ''} placeholder="e.g. Berlin" /></Field>
        </div>
        <button class="btn primary mt8" type="submit">Apply</button>
        <a class="btn mt8" href="/analytics">Reset</a>
      </form>

      <div class="grid g5 mb16">
        <Stat label="Applications" value={m.applications} meta={`${d.shortlisted} shortlisted`} />
        <Stat label="Shortlist rate" value={`${m.shortlist_rate}%`} meta={`${d.shortlisted}/${d.applications}`} />
        <Stat label="Interview → offer" value={`${m.interview_to_offer}%`} meta={`${d.offers_raised}/${d.interviewed}`} />
        <Stat label="Offer acceptance" value={`${m.offer_acceptance_rate}%`} meta={`${d.offers_decided} decided`} />
        <Stat label="Requisition aging" value={`${m.requisition_aging}d`} meta={`${d.aging_samples} open reqs`} />
      </div>

      <div class="grid g5 mb16">
        <Stat label="Time to screen" value={m.time_to_screen} meta="median hours" />
        <Stat label="Time to interview" value={m.time_to_interview} meta="median hours" />
        <Stat label="Time to offer" value={m.time_to_offer} meta="median hours" />
        <Stat label="Time to fill" value={m.time_to_fill} meta="median days" />
        <Stat label="Time to hire" value={m.time_to_hire} meta="median days" />
      </div>

      <div class="split mb16">
        <Card title="Stage conversion" sub={`${d.applications} applications in scope`}>
          <FunnelChart funnel={analytics.funnel} />
          <div class="spec-note mt16 tiny">
            Conversion is calculated from the highest stage each application actually reached in its stage history —
            not the current stage — so rejected candidates still count toward stages they passed.
          </div>
        </Card>
        <Card title="Bottleneck & source insights" sub="Rule-based, fully explained">
          {insights.insights.length === 0 ? <Empty icon="fa-circle-check" title="No bottlenecks detected" /> : (
            <div class="stack">
              {insights.insights.map((i: any) => (
                <div class={`${i.severity === 'critical' ? 'danger-note' : i.severity === 'warning' ? 'warn-note' : 'spec-note'}`}>
                  <b>{i.title}</b>
                  <div class="small mt8">{i.detail}</div>
                  <div class="tiny mono mt8" style="opacity:.75">inputs: {i.inputs.join(' · ')}</div>
                </div>
              ))}
              <div class="tiny muted">{insights.disclaimer}</div>
            </div>
          )}
        </Card>
      </div>

      <div class="grid g2 mb16">
        <Card title="Source performance" tight sub="Applications, conversion and hires by source">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Source</th><th class="num">Apps</th><th class="num">Shortlist</th><th class="num">Interview</th><th class="num">Hired</th><th class="num">Conv.</th></tr></thead>
              <tbody>
                {analytics.bySource.map((s: any) => (
                  <tr>
                    <td class="cell-main">{s.source}</td>
                    <td class="num">{s.applications}</td>
                    <td class="num">{s.shortlisted}</td>
                    <td class="num">{s.interviewed}</td>
                    <td class="num">{s.hired}</td>
                    <td class="num"><Badge tone={s.conversion > 10 ? 'ok' : s.conversion > 4 ? 'warn' : 'slate'}>{s.conversion}%</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div class="stack">
          <Card title="Drop-off & rejection reasons">
            {analytics.dropOffReasons.length === 0 ? <Empty icon="fa-ban" title="No recorded reasons" /> : (
              <Bars rows={analytics.dropOffReasons.map((r: any) => ({ label: r.reason, value: r.count }))} />
            )}
          </Card>
          <Card title="Recruiter workload">
            <table>
              <thead><tr><th>Recruiter</th><th class="num">Apps</th><th class="num">Active</th><th class="num">Hired</th><th class="num">Overdue</th></tr></thead>
              <tbody>
                {analytics.byRecruiter.map((r: any) => (
                  <tr>
                    <td class="small">{r.recruiter}</td>
                    <td class="num small">{r.applications}</td>
                    <td class="num small">{r.active}</td>
                    <td class="num small">{r.hired}</td>
                    <td class="num small">{r.overdue > 0 ? <Badge tone="danger">{r.overdue}</Badge> : '0'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </div>

      <Card title="Metric definitions" sub="Documented numerators, denominators and units — identical to the export">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Metric</th><th>Definition</th><th>Numerator</th><th>Denominator</th><th>Unit</th><th class="num">Value</th></tr></thead>
            <tbody>
              {METRIC_DEFS.map((md) => (
                <tr>
                  <td class="cell-main small">{md.label}</td>
                  <td class="small muted" style="max-width:340px">{md.definition}</td>
                  <td class="tiny mono">{md.numerator}</td>
                  <td class="tiny mono">{md.denominator}</td>
                  <td class="tiny">{md.unit}</td>
                  <td class="num small"><b>{m[md.key]}{md.unit === 'percent' ? '%' : ''}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Layout>
  )
}

export const DistributionPage = ({ user, data, jobFilter }: { user: AuthUser; data: any; jobFilter?: number }) => {
  const { jobs, postings, channels, events } = data
  const filtered = jobFilter ? postings.filter((p: any) => p.job_id === jobFilter) : postings
  const counts: any = filtered.reduce((a: any, p: any) => { a[p.status] = (a[p.status] || 0) + 1; return a }, {})

  return (
    <Layout user={user} active="/distribution" title="Job distribution">
      <PageHead
        title="Job posting & distribution"
        sub="Publication tracked per channel: draft, queued, published, failed, expired, withdrawn. Channels without a supported publishing API are marked manual-export only and cannot be auto-published."
        actions={
          <form method="get" action="/distribution" class="row" style="gap:6px">
            <select name="job" style="width:230px">
              <option value="">All requisitions</option>
              {jobs.map((j: any) => <option value={j.id} selected={String(jobFilter) === String(j.id)}>{j.title}</option>)}
            </select>
            <button class="btn" type="submit">Filter</button>
          </form>
        }
      />

      <div class="grid g4 mb16">
        <Stat label="Published" value={counts.published || 0} />
        <Stat label="Failed" value={counts.failed || 0} tone={counts.failed ? 'var(--danger)' : undefined} />
        <Stat label="Queued" value={counts.queued || 0} />
        <Stat label="Withdrawn / expired" value={(counts.withdrawn || 0) + (counts.expired || 0)} />
      </div>

      <div class="spec-note mb16">
        <b>Capability disclosure:</b> channels marked <span class="mono">API supported</span> accept published postings via a partner API in this deployment
        (simulated provider). Channels marked <span class="mono">manual export only</span> have no supported publishing API — the app records the intent,
        shows the failure reason, and never claims the posting went live.
      </div>

      <Card title="Postings" tight sub={`${filtered.length} posting records`}>
        {filtered.length === 0 ? <Empty icon="fa-bullhorn" title="No postings" /> : (
          <div class="table-wrap">
            <table>
              <thead><tr><th>Requisition</th><th>Channel</th><th>Status</th><th>External ID</th><th>Posted</th><th>Expires</th><th>Attempts</th><th></th></tr></thead>
              <tbody>
                {filtered.map((p: any) => (
                  <tr>
                    <td><a href={`/jobs/${p.job_id}`} class="cell-main small" style="text-decoration:none">{p.job_title}</a><div class="cell-sub mono">{p.job_code}</div></td>
                    <td class="small">
                      {p.channel_name}
                      <div class="cell-sub">{p.api_supported ? 'API supported' : 'Manual export only'}</div>
                    </td>
                    <td>
                      <Badge tone={p.status === 'published' ? 'ok' : p.status === 'failed' ? 'danger' : p.status === 'queued' ? 'warn' : 'slate'} dot>{titleCase(p.status)}</Badge>
                      {p.last_error ? <div class="cell-sub" title={p.last_error}>{p.last_error.slice(0, 34)}…</div> : null}
                    </td>
                    <td class="tiny mono">{p.external_id || '—'}</td>
                    <td class="tiny muted nowrap">{p.posted_at ? fmtDate(p.posted_at) : '—'}</td>
                    <td class="tiny muted nowrap">{p.expires_at ? fmtDate(p.expires_at) : '—'}</td>
                    <td class="num tiny">{p.attempts}</td>
                    <td class="nowrap">
                      {['draft', 'failed', 'expired', 'withdrawn'].includes(p.status) ? (
                        <button class="btn sm" data-act={`/api/postings/${p.id}/publish`} data-reload="1">
                          {p.status === 'failed' ? 'Retry' : 'Publish'}
                        </button>
                      ) : p.status === 'published' ? (
                        <button class="btn sm ghost" data-act={`/api/postings/${p.id}/withdraw`} data-reload="1">Withdraw</button>
                      ) : (
                        <button class="btn sm" data-act={`/api/postings/${p.id}/publish`} data-reload="1">Send</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div class="grid g2 mt16">
        <Card title="Channels" tight>
          <table>
            <thead><tr><th>Channel</th><th>Type</th><th>API</th><th>Enabled</th></tr></thead>
            <tbody>
              {channels.map((c: any) => (
                <tr>
                  <td class="cell-main small">{c.name}</td>
                  <td class="tiny">{titleCase(c.type)}</td>
                  <td>{c.api_supported ? <Badge tone="ok">Supported</Badge> : <Badge tone="slate">Manual</Badge>}</td>
                  <td>{c.enabled ? <Badge tone="brand">On</Badge> : <Badge tone="slate">Off</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Posting log" tight>
          {events.length === 0 ? <Empty icon="fa-list" title="No events" /> : (
            <div class="table-wrap" style="max-height:320px;overflow-y:auto">
              <table>
                <tbody>
                  {events.slice(0, 30).map((e: any) => (
                    <tr>
                      <td class="small">
                        <b>{e.action}</b> · {e.channel_name}
                        <div class="cell-sub">{e.detail || '—'}</div>
                      </td>
                      <td class="tiny muted nowrap">{fmtDate(e.created_at)}</td>
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

export const CommunicationsPage = ({ user, data, filter, candidateId }: {
  user: AuthUser; data: any; filter: string; candidateId?: number
}) => {
  const { messages, templates, counts, candidates } = data
  const tabs = [['', 'All'], ['sent', 'Sent'], ['failed', 'Failed'], ['bounced', 'Bounced'], ['queued', 'Queued']]

  return (
    <Layout user={user} active="/communications" title="Communications">
      <PageHead
        title="Candidate communication center"
        sub="Templates and personalised messages for acknowledgement, screening, interview, reschedule, rejection, offer and withdrawal. Opt-out and consent are enforced before sending; delivery failures are surfaced, never hidden."
      />

      <div class="grid g4 mb16">
        <Stat label="Sent" value={counts.sent || 0} />
        <Stat label="Failed" value={counts.failed || 0} tone={counts.failed ? 'var(--danger)' : undefined} />
        <Stat label="Bounced" value={counts.bounced || 0} />
        <Stat label="Templates" value={templates.length} meta={`${templates.filter((t: any) => t.active).length} active`} />
      </div>

      <div class="split">
        <div class="stack">
          {user.role !== 'interviewer' ? (
            <Card title="Compose message">
              <form data-api="/api/messages" data-method="post" data-reload="1">
                <div class="form-grid">
                  <Field label="Recipient" full>
                    <select name="candidate_id" required>
                      <option value="">Select candidate…</option>
                      {candidates.map((c: any) => (
                        <option value={c.id} selected={candidateId === c.id}>
                          {c.first_name} {c.last_name} — {c.consent_status === 'opt_out' ? '(opted out — blocked)' : c.email}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Template">
                    <select name="template_id">
                      <option value="">— custom message —</option>
                      {templates.filter((t: any) => t.active).map((t: any) => <option value={t.id}>{t.name} ({t.category})</option>)}
                    </select>
                  </Field>
                  <Field label="Channel">
                    <select name="channel"><option value="email">Email</option><option value="sms">SMS</option></select>
                  </Field>
                  <Field label="Subject" full><input type="text" name="subject" placeholder="Uses the template subject if blank" /></Field>
                  <Field label="Body" full help="Placeholders: {{first_name}} {{job_title}}">
                    <textarea name="body" rows={5} placeholder="Leave blank to use the template body" />
                  </Field>
                </div>
                <button class="btn primary mt16" type="submit"><i class="fa-solid fa-paper-plane"></i> Send message</button>
              </form>
            </Card>
          ) : null}

          <div class="tabs" style="margin-top:4px">
            {tabs.map(([v, l]) => (
              <a href={`/communications${v ? `?status=${v}` : ''}${candidateId ? `&candidate=${candidateId}` : ''}`} class={filter === v ? 'active' : ''}>
                {l}{v && counts[v] ? <span class="n">{counts[v]}</span> : null}
              </a>
            ))}
          </div>

          <Card tight>
            {messages.length === 0 ? <Empty icon="fa-envelope-open" title="No messages" /> : (
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Recipient</th><th>Subject</th><th>Template</th><th>Status</th><th>Sent</th></tr></thead>
                  <tbody>
                    {messages.map((m: any) => (
                      <tr>
                        <td class="small"><a href={`/candidates/${m.candidate_id}`}>{m.first_name} {m.last_name}</a><div class="cell-sub mono tiny">{m.to_address}</div></td>
                        <td class="small">{m.subject}</td>
                        <td class="tiny">{m.template_name || 'Custom'}</td>
                        <td>
                          <Badge tone={m.status === 'sent' ? 'ok' : ['failed', 'bounced'].includes(m.status) ? 'danger' : 'warn'} dot>{titleCase(m.status)}</Badge>
                          {m.error ? <div class="cell-sub" title={m.error}>{m.error.slice(0, 26)}</div> : null}
                        </td>
                        <td class="tiny muted nowrap">{m.sent_at ? fmtDate(m.sent_at) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div class="stack">
          <Card title="Templates" tight>
            <table>
              <tbody>
                {templates.map((t: any) => (
                  <tr>
                    <td>
                      <div class="cell-main small">{t.name}</div>
                      <div class="cell-sub">{titleCase(t.category)} · {t.channel}</div>
                    </td>
                    <td>{t.active ? <Badge tone="ok">Active</Badge> : <Badge tone="slate">Off</Badge>}</td>
                    <td><button class="btn ghost sm" onclick={`openModal('tpl-${t.id}')`}><i class="fa-solid fa-eye" style="font-size:10px"></i></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Consent rules">
            <ul class="small muted" style="line-height:1.8;padding-left:18px">
              <li>Opted-out candidates are blocked at send time.</li>
              <li>Unknown consent requires manual confirmation.</li>
              <li>Bulk sends validate every recipient before queueing.</li>
              <li>All sends are recorded with provider response and audit entry.</li>
            </ul>
          </Card>
        </div>
      </div>

      {templates.map((t: any) => (
        <dialog class="modal" id={`tpl-${t.id}`}>
          <header><h3>{t.name}</h3><button class="btn ghost sm" onclick={`closeModal('tpl-${t.id}')`}><i class="fa-solid fa-xmark"></i></button></header>
          <div class="body">
            <div class="tiny muted" style="text-transform:uppercase;font-weight:700;margin-bottom:5px">Subject</div>
            <p class="small">{t.subject}</p>
            <hr />
            <div class="tiny muted" style="text-transform:uppercase;font-weight:700;margin-bottom:5px">Body</div>
            <pre class="snippet" style="white-space:pre-wrap">{t.body}</pre>
          </div>
          <footer><button class="btn" onclick={`closeModal('tpl-${t.id}')`}>Close</button></footer>
        </dialog>
      ))}
    </Layout>
  )
}

export const ManagerPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { queue, requirements, feedbackDue } = data
  return (
    <Layout user={user} active="/manager" title="Manager review">
      <PageHead
        title="Hiring manager review"
        sub="Candidates shortlisted on requisitions you own. Shortlist, reject or request more information, with comments and scorecard visibility. You only see requisitions and candidates assigned to you."
      />

      <div class="grid g4 mb16">
        <Stat label="Awaiting review" value={queue.length} />
        <Stat label="My requisitions" value={requirements.length} />
        <Stat label="Feedback due" value={feedbackDue} tone={feedbackDue ? 'var(--warn)' : undefined} />
        <Stat label="Decided this week" value={data.decidedThisWeek} />
      </div>

      <Card title="Review queue" tight sub={`${queue.length} candidates at manager review`}>
        {queue.length === 0 ? <Empty icon="fa-check-double" title="Nothing to review" sub="Shortlisted candidates will appear here." /> : (
          <div class="table-wrap">
            <table>
              <thead><tr><th>Candidate</th><th>Requisition</th><th>Recruiter</th><th>In stage</th><th>Actions</th></tr></thead>
              <tbody>
                {queue.map((a: any) => (
                  <tr>
                    <td><a href={`/applications/${a.id}`} style="text-decoration:none;color:inherit"><div class="cell-main">{a.first_name} {a.last_name}</div><div class="cell-sub">{a.headline}</div></a></td>
                    <td class="small">{a.job_title}<div class="cell-sub mono">{a.job_code}</div></td>
                    <td class="small">{a.recruiter_name || '—'}</td>
                    <td class="small">{Math.round(a.hours_in_stage)}h</td>
                    <td class="nowrap">
                      <button class="btn sm primary" data-act={`/api/applications/${a.id}/stage`} data-body='{"to_stage":"interview"}' data-reload="1">Shortlist</button>
                      <button class="btn sm" data-act={`/api/applications/${a.id}/review`} data-body='{"decision":"request_more_info"}' data-prompt="What additional information do you need?" data-reload="1">More info</button>
                      <button class="btn sm danger" data-act={`/api/applications/${a.id}/status`} data-body='{"status":"rejected"}' data-prompt="Rejection reason" data-reload="1">Reject</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="My requisitions" tight sub={`${requirements.length} assigned`} >
        <table>
          <thead><tr><th>Requisition</th><th>Status</th><th class="num">Apps</th><th class="num">In review</th><th class="num">Interviews</th><th class="num">Offers</th></tr></thead>
          <tbody>
            {requirements.map((j: any) => (
              <tr>
                <td><a href={`/jobs/${j.id}`} class="cell-main small" style="text-decoration:none">{j.title}</a><div class="cell-sub mono">{j.code}</div></td>
                <td><Badge tone={j.status === 'open' ? 'ok' : 'slate'} dot>{titleCase(j.status)}</Badge></td>
                <td class="num small">{j.applications}</td>
                <td class="num small">{j.in_review}</td>
                <td class="num small">{j.interviews}</td>
                <td class="num small">{j.offers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Layout>
  )
}
