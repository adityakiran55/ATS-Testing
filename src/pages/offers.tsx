import { Layout } from '../components/layout'
import { PageHead, Card, Stat, Person, Empty, Badge, OfferStatus, Field, Meta } from '../components/ui'
import { fmtDate, fmtDateTime, relTime, titleCase, truncate, money } from '../lib/util'
import { OFFER_TRANSITIONS, ONBOARDING_TRANSITIONS } from '../lib/lifecycle'
import type { AuthUser } from '../lib/auth'
import { can } from '../lib/rbac'

export const OffersPage = ({ user, data, filter }: { user: AuthUser; data: any; filter: string }) => {
  const { offers } = data
  const tabs = [
    ['', 'All'], ['approval_pending', 'Approval pending'], ['approved', 'Approved'],
    ['released', 'Released'], ['accepted', 'Accepted'], ['declined', 'Declined']
  ]
  const counts: any = offers.reduce((a: any, o: any) => { a[o.status] = (a[o.status] || 0) + 1; return a }, {})
  const accepted = offers.filter((o: any) => o.status === 'accepted').length
  const decided = offers.filter((o: any) => ['accepted', 'declined'].includes(o.status)).length

  return (
    <Layout user={user} active="/offers" title="Offers">
      <PageHead
        title="Offers"
        sub="Offer preparation, approval, release and candidate response. Revisions create a new version — versions are never overwritten."
        actions={<a class="btn" href="/pipeline"><i class="fa-solid fa-diagram-project"></i> Raise from pipeline</a>}
      />
      <div class="grid g4 mb16">
        <Stat label="Awaiting approval" value={counts.approval_pending || 0} />
        <Stat label="Released" value={counts.released || 0} meta="With candidate" />
        <Stat label="Accepted" value={accepted} />
        <Stat label="Acceptance rate" value={decided ? `${Math.round((accepted / decided) * 100)}%` : '—'} meta={`${decided} decided`} />
      </div>

      <div class="tabs">
        {tabs.map(([v, l]) => (
          <a href={`/offers${v ? `?status=${v}` : ''}`} class={filter === v ? 'active' : ''}>{l}{v && counts[v] ? <span class="n">{counts[v]}</span> : null}</a>
        ))}
      </div>

      <Card tight>
        {offers.length === 0 ? <Empty icon="fa-file-signature" title="No offers" /> : (
          <div class="table-wrap">
            <table>
              <thead><tr><th>Candidate</th><th>Requisition</th><th>Package</th><th>Status</th><th>Expires</th><th></th></tr></thead>
              <tbody>
                {offers.map((o: any) => (
                  <tr>
                    <td><a href={`/candidates/${o.candidate_id}`} style="text-decoration:none;color:inherit"><Person first={o.first_name} last={o.last_name} sub={o.email} small /></a></td>
                    <td class="small"><a href={`/jobs/${o.job_id}`}>{truncate(o.job_title, 24)}</a><div class="cell-sub mono">{o.job_code}</div></td>
                    <td class="small">{money(o.base_salary, o.currency)}<div class="cell-sub">+ {money(o.bonus, o.currency)} bonus</div></td>
                    <td><OfferStatus status={o.status} /><div class="cell-sub">v{o.version}</div></td>
                    <td class="tiny muted nowrap">{o.expires_at ? fmtDate(o.expires_at) : '—'}</td>
                    <td class="nowrap"><a class="btn sm" href={`/offers/${o.id}`}>Open</a></td>
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

export const OfferDetailPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { offer: o, candidate, job, versions, audit } = data
  const transitions = (OFFER_TRANSITIONS[o.status] || []).filter((t) => can(user.role, t.perm))

  return (
    <Layout user={user} active="/offers" title="Offer">
      <PageHead
        title={`Offer — ${candidate.first_name} ${candidate.last_name}`}
        sub={`${job.title} · version ${o.version} · created ${fmtDate(o.created_at)} by ${o.creator_name || '—'}`}
        actions={
          <>
            <OfferStatus status={o.status} />
            {transitions.map((t) => (
              <button
                class={`btn ${['approval_pending', 'released'].includes(t.to) ? 'primary' : t.to === 'withdrawn' ? 'danger' : ''}`}
                data-act={`/api/offers/${o.id}/status`}
                data-body={JSON.stringify({ to: t.to })}
                data-prompt={['declined', 'expired', 'withdrawn'].includes(t.to) ? `${t.label} — note (optional)` : undefined}
                data-reload="1"
              >{t.label}</button>
            ))}
            {can(user.role, 'offer.create') ? (
              <button class="btn" data-act={`/api/offers/${o.id}/revise`} data-confirm="Create a new version of this offer? The current version is preserved." data-reload="1">
                <i class="fa-solid fa-code-branch"></i> New version
              </button>
            ) : null}
          </>
        }
      />

      <div class="grid g4 mb16">
        <Stat label="Base salary" value={money(o.base_salary, o.currency)} />
        <Stat label="Bonus" value={money(o.bonus, o.currency)} />
        <Stat label="Equity" value={o.equity || '—'} />
        <Stat label="Start date" value={o.start_date ? fmtDate(o.start_date) : '—'} meta={o.expires_at ? `expires ${fmtDate(o.expires_at)}` : ''} />
      </div>

      <div class="split">
        <div class="stack">
          <Card title="Offer lifecycle">
            <div class="small muted mb16" style="line-height:1.9">
              {['draft', 'approval_pending', 'approved', 'released', 'accepted'].map((s, i) => (
                <>
                  {i > 0 ? <span style="margin:0 6px">→</span> : null}
                  <Badge tone={o.status === s ? 'brand' : ['accepted'].includes(s) ? 'ok' : 'slate'} dot>{titleCase(s)}</Badge>
                </>
              ))}
              <div class="mt8 tiny">Terminal alternates: declined · expired · withdrawn</div>
            </div>
            <Meta items={[
              ['Approved by', o.approver_name || '—'],
              ['Approved at', o.approved_at ? fmtDateTime(o.approved_at) : '—'],
              ['Released at', o.released_at ? fmtDateTime(o.released_at) : '—'],
              ['Responded at', o.responded_at ? fmtDateTime(o.responded_at) : '—'],
              ['Response note', o.response_note || '—'],
              ['Approval note', o.approval_note || '—']
            ]} />
          </Card>

          <Card title="Version history" tight>
            <table>
              <thead><tr><th>Version</th><th>Status</th><th>Base</th><th>Created</th></tr></thead>
              <tbody>
                {versions.map((v: any) => (
                  <tr>
                    <td class="small"><b>v{v.version}</b>{v.version === o.version ? <span class="badge brand" style="margin-left:5px">current</span> : null}</td>
                    <td><OfferStatus status={v.status} /></td>
                    <td class="small">{money(v.base_salary, v.currency)}</td>
                    <td class="tiny muted">{fmtDate(v.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Offer audit" tight>
            {audit.length === 0 ? <Empty icon="fa-clock-rotate-left" title="No audit entries" /> : (
              <table>
                <tbody>
                  {audit.map((a: any) => (
                    <tr>
                      <td class="small">{titleCase(a.action)}</td>
                      <td class="tiny">{a.previous_value} → {a.new_value}</td>
                      <td class="tiny muted nowrap">{fmtDate(a.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div class="stack">
          <Card title="Candidate">
            <Person first={candidate.first_name} last={candidate.last_name} sub={candidate.email} />
            <hr />
            <Meta items={[
              ['Requisition', <a href={`/jobs/${job.id}`} class="small">{job.title}</a>],
              ['Applied', <span class="small">{fmtDate(job.applied_at)}</span>],
              ['Notes', <span class="small">{o.notes || '—'}</span>]
            ]} />
          </Card>
          {can(user.role, 'offer.approve') && o.status === 'approval_pending' ? (
            <Card title="Approver actions">
              <form data-api={`/api/offers/${o.id}/status`} data-method="post" data-reload="1">
                <input type="hidden" name="to" value="approved" />
                <Field label="Approval note"><textarea name="reason" rows={3} placeholder="Budget, band confirmation…" /></Field>
                <button class="btn primary mt8" type="submit"><i class="fa-solid fa-check"></i> Approve offer</button>
              </form>
            </Card>
          ) : null}
        </div>
      </div>
    </Layout>
  )
}

export const OnboardingPage = ({ user, data }: { user: AuthUser; data: any }) => (
  <Layout user={user} active="/onboarding" title="Onboarding handoff">
    <PageHead
      title="Onboarding handoff"
      sub="Post-hire recruitment handoff only. Tracks documents and tasks from initiation through to joining. This is not an HRMS — employee lifecycle management is out of scope."
    />

    <div class="grid g4 mb16">
      <Stat label="In progress" value={data.items.filter((i: any) => ['initiated', 'pending_documents'].includes(i.status)).length} />
      <Stat label="Ready to join" value={data.items.filter((i: any) => i.status === 'ready_to_join').length} />
      <Stat label="Joined" value={data.items.filter((i: any) => i.status === 'joined').length} />
      <Stat label="No show" value={data.items.filter((i: any) => i.status === 'no_show').length} tone="var(--danger)" />
    </div>

    {data.items.length === 0 ? <Card><Empty icon="fa-door-open" title="No onboarding handoffs" sub="Handoffs appear once an offer is accepted." /></Card> : (
      <div class="stack">
        {data.items.map((o: any) => {
          const nextStates = ONBOARDING_TRANSITIONS[o.status] || []
          return (
            <Card key={o.id} title={`${o.first_name} ${o.last_name} — ${o.job_title}`}
              sub={`${o.job_code} · ${o.location} · ${o.tasks.filter((t: any) => t.done).length}/${o.tasks.length} tasks complete`}
              actions={
                <>
                  <Badge tone={o.status === 'joined' ? 'ok' : o.status === 'no_show' ? 'danger' : 'info'} dot>{titleCase(o.status)}</Badge>
                  {can(user.role, 'onboarding.manage') ? nextStates.map((s: string) => (
                    <button class="btn sm" data-act={`/api/onboarding/${o.id}/status`} data-body={JSON.stringify({ to: s })} data-reload="1">
                      {titleCase(s)}
                    </button>
                  )) : null}
                </>
              }>
              <div class="grid g2">
                <div>
                  <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-bottom:7px">Tasks</div>
                  {o.tasks.map((t: any) => (
                    <div class="row" style="gap:8px;margin-bottom:7px">
                      <i class={`fa-solid ${t.done ? 'fa-circle-check' : 'fa-circle'}`} style={t.done ? 'color:var(--ok)' : 'color:#cbd5e1'}></i>
                      <span class={t.done ? 'small muted' : 'small'} style={t.done ? 'text-decoration:line-through' : ''}>{t.label}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <Meta items={[
                    ['Start date', o.start_date ? fmtDate(o.start_date) : '—'],
                    ['Initiated', o.initiated_at ? fmtDate(o.initiated_at) : '—'],
                    ['Ready', o.ready_at ? fmtDate(o.ready_at) : '—'],
                    ['Joined', o.joined_at ? fmtDate(o.joined_at) : '—']
                  ]} />
                </div>
              </div>
            </Card>
          )
        })}
      </div>
    )}
  </Layout>
)

export const PoolsPage = ({ user, data }: { user: AuthUser; data: any }) => (
  <Layout user={user} active="/pools" title="Talent pools">
    <PageHead
      title="Talent pools, folders & re-engagement"
      sub="Organise candidates into pools and folders, track membership, ownership, source, last contact, consent and re-engagement status. Outreach respects consent — opted-out candidates are blocked."
      actions={
        <button class="btn primary" onclick="openModal('pool-modal')"><i class="fa-solid fa-plus"></i> New pool</button>
      }
    />

    <div class="grid g3 mb16">
      {data.pools.map((p: any) => (
        <Card key={p.id} title={p.name} sub={`${p.kind} · ${p.members} members`}
          actions={<Badge tone={p.visibility === 'private' ? 'slate' : 'brand'}>{p.visibility}</Badge>}>
          <p class="small muted" style="min-height:34px">{p.description || 'No description'}</p>
          <div class="grid g3 mt8" style="gap:8px">
            <div><div class="tiny muted">Interested</div><b>{p.interested}</b></div>
            <div><div class="tiny muted">Not contacted</div><b>{p.not_contacted}</b></div>
            <div><div class="tiny muted">Owner</div><b class="small">{p.owner_name || '—'}</b></div>
          </div>
          <hr />
          <div class="row" style="gap:6px">
            <a class="btn sm" href={`/pools/${p.id}`}>Open pool</a>
            <a class="btn sm ghost" href={`/candidates?poolId=${p.id}`}>Search within</a>
          </div>
        </Card>
      ))}
    </div>

    <dialog class="modal" id="pool-modal">
      <header><h3>New talent pool</h3><button class="btn ghost sm" onclick="closeModal('pool-modal')"><i class="fa-solid fa-xmark"></i></button></header>
      <form data-api="/api/pools" data-method="post" data-reload="1">
        <div class="body">
          <div class="form-grid">
            <Field label="Name" full><input type="text" name="name" required placeholder="Senior Engineers — EMEA" /></Field>
            <Field label="Type">
              <select name="kind"><option value="pool">Pool</option><option value="folder">Folder</option></select>
            </Field>
            <Field label="Visibility">
              <select name="visibility"><option value="team">Team</option><option value="private">Private</option></select>
            </Field>
            <Field label="Description" full><textarea name="description" rows={3} /></Field>
          </div>
        </div>
        <footer>
          <button class="btn" type="button" onclick="closeModal('pool-modal')">Cancel</button>
          <button class="btn primary" type="submit">Create pool</button>
        </footer>
      </form>
    </dialog>
  </Layout>
)

export const PoolDetailPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { pool, members } = data
  const eligible = members.filter((m: any) => m.consent_status !== 'opt_out')
  return (
    <Layout user={user} active="/pools" title={pool.name}>
      <PageHead
        title={pool.name}
        sub={pool.description || `${pool.kind} · ${members.length} members`}
        actions={
          <>
            <Badge tone="brand">{pool.kind}</Badge>
            <a class="btn" href={`/candidates?poolId=${pool.id}`}><i class="fa-solid fa-magnifying-glass"></i> Search within pool</a>
            <button class="btn primary" data-act="/api/pools/reengage" data-body={JSON.stringify({ pool_id: pool.id, template_id: 2 })} data-confirm={`Send re-engagement message to ${eligible.length} consenting members?`} data-reload="1">
              <i class="fa-solid fa-paper-plane"></i> Re-engage ({eligible.length})
            </button>
          </>
        }
      />
      <Card title="Members" tight sub={`${members.length} candidates · ${members.filter((m: any) => m.consent_status === 'opt_out').length} opted out`}>
        {members.length === 0 ? <Empty icon="fa-users" title="No members" /> : (
          <div class="table-wrap">
            <table>
              <thead><tr><th>Candidate</th><th>Source</th><th>Notes</th><th>Last contact</th><th>Re-engagement</th><th>Consent</th><th></th></tr></thead>
              <tbody>
                {members.map((m: any) => (
                  <tr>
                    <td><a href={`/candidates/${m.candidate_id}`} style="text-decoration:none;color:inherit"><Person first={m.first_name} last={m.last_name} sub={m.headline} small /></a></td>
                    <td class="tiny">{m.source || '—'}</td>
                    <td class="small" style="max-width:200px">{truncate(m.notes || '—', 40)}</td>
                    <td class="tiny muted nowrap">{m.last_contact_at ? relTime(m.last_contact_at) : 'never'}</td>
                    <td>
                      <select
                        style="font-size:11px;padding:3px 6px"
                        data-act={`/api/pools/${pool.id}/members/${m.candidate_id}`}
                        data-method="PATCH"
                        onchange={`window.api('/api/pools/${pool.id}/members/${m.candidate_id}',{method:'PATCH',body:{re_engagement:this.value}}).then(()=>toast('Updated','ok')).catch(e=>toast(e.message,'err'))`}
                      >
                        {['not_contacted', 'contacted', 'interested', 'not_interested', 'hired'].map((r) => (
                          <option value={r} selected={m.re_engagement === r}>{titleCase(r)}</option>
                        ))}
                      </select>
                    </td>
                    <td><Badge tone={m.consent_status === 'opt_in' ? 'ok' : m.consent_status === 'opt_out' ? 'danger' : 'slate'}>{titleCase(m.consent_status)}</Badge></td>
                    <td class="nowrap">
                      <button class="btn ghost sm" data-act={`/api/pools/${pool.id}/members/${m.candidate_id}`} data-method="DELETE" data-reload="1" title="Remove">
                        <i class="fa-solid fa-xmark"></i>
                      </button>
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
