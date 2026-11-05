import { Layout } from '../components/layout'
import {
  PageHead, Card, Stat, Person, Empty, Badge, StageBadge, AppStatus, Avatar, Meta,
  ResumeStatus, MsgStatus, AgingPill, AiBadge, Confidence, Timeline, Field
} from '../components/ui'
import { fmtDate, fmtDateTime, relTime, titleCase, truncate, money, nowIso, hoursBetween } from '../lib/util'
import { SORT_OPTIONS } from '../lib/search'
import type { AuthUser } from '../lib/auth'
import { can } from '../lib/rbac'

/* ------------------------------------------------------------------ search */
export const CandidateSearchPage = ({ user, data, params }: { user: AuthUser; data: any; params: any }) => {
  const { results, total, savedSearches, pools, audit, plan, tabs } = data
  const filters = params

  return (
    <Layout user={user} active="/candidates" title="Talent search" query={params.q}>
      <PageHead
        title="Talent search & rediscovery"
        sub="Search parsed resume text, skills, titles, employers, education, location, experience, notice period, salary, tags and previous applications. Boolean operators AND / OR / NOT, exact phrases and field prefixes (skill:, title:, employer:, location:) are supported."
        actions={<a class="btn" href="/candidates/duplicates"><i class="fa-solid fa-clone"></i> Duplicate review</a>}
      />

      <div class="tabs">
        {tabs.map((t: any) => (
          <a href={t.href} class={t.active ? 'active' : ''}>{t.label}{t.count !== undefined ? <span class="n">{t.count}</span> : null}</a>
        ))}
      </div>

      <form method="get" action="/candidates" class="card mb16" style="padding:14px">
        <div class="row wrap" style="gap:8px;margin-bottom:10px">
          <div style="flex:1;min-width:280px">
            <input
              type="text" name="q" value={params.q || ''} class="querybox"
              placeholder='(skill:react OR skill:vue) AND title:senior AND NOT employer:competitor'
            />
          </div>
          <select name="mode" style="width:130px">
            <option value="boolean" selected={params.mode !== 'semantic'}>Boolean</option>
            <option value="semantic" selected={params.mode === 'semantic'}>Semantic</option>
          </select>
          <button class="btn primary" type="submit"><i class="fa-solid fa-magnifying-glass"></i> Search</button>
          {params.q ? <a class="btn" href="/candidates">Clear</a> : null}
        </div>

        <details>
          <summary class="small muted" style="cursor:pointer;user-select:none">
            <i class="fa-solid fa-sliders" style="margin-right:5px"></i>Filters & sorting
          </summary>
          <div class="form-grid mt16">
            <Field label="Skills (comma separated)"><input type="text" name="skills" value={params.skills || ''} /></Field>
            <Field label="Location"><input type="text" name="location" value={params.location || ''} /></Field>
            <Field label="Min experience (years)"><input type="number" name="minExperience" value={params.minExperience || ''} min="0" /></Field>
            <Field label="Max notice period (days)"><input type="number" name="maxNotice" value={params.maxNotice || ''} min="0" /></Field>
            <Field label="Max salary expectation"><input type="number" name="maxSalary" value={params.maxSalary || ''} /></Field>
            <Field label="Tag"><input type="text" name="tags" value={params.tags || ''} placeholder="e.g. Senior" /></Field>
            <Field label="Consent status">
              <select name="consent">
                <option value="">Any</option>
                <option value="opt_in" selected={params.consent === 'opt_in'}>Opted in</option>
                <option value="unknown" selected={params.consent === 'unknown'}>Unknown</option>
                <option value="opt_out" selected={params.consent === 'opt_out'}>Opted out</option>
              </select>
            </Field>
            <Field label="Talent pool">
              <select name="poolId">
                <option value="">Any</option>
                {pools.map((p: any) => <option value={p.id} selected={String(params.poolId) === String(p.id)}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Previously applied to requisition">
              <select name="appliedToJobId">
                <option value="">Any</option>
                {data.jobs.map((j: any) => <option value={j.id} selected={String(params.appliedToJobId) === String(j.id)}>{j.title}</option>)}
              </select>
            </Field>
            <Field label="Sort by">
              <select name="sort">
                {Object.entries(SORT_OPTIONS).map(([k, v]) => (
                  <option value={k} selected={(params.sort || 'relevance') === k}>{v}</option>
                ))}
              </select>
            </Field>
          </div>
          <button class="btn primary mt16" type="submit">Apply filters</button>
        </details>
      </form>

      {plan ? (
        <div class="ai-panel mb16">
          <header><i class="fa-solid fa-wand-magic-sparkles" style="color:#7c3aed"></i><b>Query interpretation</b><AiBadge /></header>
          <div class="card-body">
            <p class="small" style="margin-bottom:8px">{plan.explanation}</p>
            <div class="row wrap" style="gap:5px;margin-bottom:8px">
              {plan.interpreted_terms.map((t: string) => <span class="chip">{t}</span>)}
            </div>
            {plan.synonyms_applied.length ? (
              <div class="small muted">Synonym expansion applied: {plan.synonyms_applied.join(', ')}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div class="split">
        <div class="stack">
          <Card
            title={`${total} candidate${total === 1 ? '' : 's'}`}
            sub={params.q ? `matching “${truncate(params.q, 44)}”` : 'all active candidates'}
            actions={
              <div class="row" style="gap:6px">
                <a class="btn sm" href={`/api/candidates/export.csv?${new URLSearchParams(params as any).toString()}`}>
                  <i class="fa-solid fa-file-csv"></i> Export
                </a>
                {params.q ? (
                  <button class="btn sm" data-act="/api/saved-searches" data-body={JSON.stringify({ name: `Search ${new Date().toISOString().slice(0, 10)}`, query: params.q, mode: params.mode || 'boolean', filters: params })} data-reload="1">
                    <i class="fa-solid fa-bookmark"></i> Save
                  </button>
                ) : null}
              </div>
            }
            tight
          >
            {results.length === 0 ? (
              <Empty icon="fa-user-slash" title="No candidates matched" sub="Try a broader query, remove filters, or switch to semantic mode." />
            ) : (
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Candidate</th>
                      <th>Signals</th>
                      <th class="num">Exp</th>
                      <th class="num">Notice</th>
                      <th class="num">Expected</th>
                      <th class="num">Apps</th>
                      <th>Consent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((c: any) => (
                      <tr>
                        <td>
                          <a href={`/candidates/${c.id}`} style="text-decoration:none;color:inherit">
                            <Person first={c.first_name} last={c.last_name} sub={c.headline} small />
                          </a>
                        </td>
                        <td style="max-width:290px">
                          {c.match_reasons && c.match_reasons.length ? (
                            <div class="row wrap" style="gap:3px">
                              {c.match_reasons.slice(0, 4).map((r: string) => <span class="tag">{r}</span>)}
                            </div>
                          ) : c.semantic_score ? (
                            <span class="badge violet">semantic {Math.round(c.semantic_score * 100)}%</span>
                          ) : <span class="muted tiny">—</span>}
                          {c.skills && c.skills.length ? (
                            <div class="tiny muted" style="margin-top:3px">{c.skills.slice(0, 3).join(' · ')}</div>
                          ) : null}
                        </td>
                        <td class="num small">{c.experience_years || '—'}</td>
                        <td class="num small">{c.notice_period_days ? `${c.notice_period_days}d` : '—'}</td>
                        <td class="num small">{c.expected_salary ? `$${Math.round(c.expected_salary / 1000)}k` : '—'}</td>
                        <td class="num small">{c.application_count || 0}</td>
                        <td>
                          <Badge tone={c.consent_status === 'opt_in' ? 'ok' : c.consent_status === 'opt_out' ? 'danger' : 'slate'}>
                            {titleCase(c.consent_status)}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {total > results.length ? (
            <div class="row between small muted">
              <span>Showing {results.length} of {total}</span>
              <div class="row" style="gap:6px">
                <a class="btn sm" href={`/candidates?${new URLSearchParams({ ...params, page: String(Math.max(1, (params.page || 1) - 1)) } as any).toString()}`}>Previous</a>
                <a class="btn sm" href={`/candidates?${new URLSearchParams({ ...params, page: String((params.page || 1) + 1) } as any).toString()}`}>Next</a>
              </div>
            </div>
          ) : null}
        </div>

        <div class="stack">
          <Card title="Saved searches" tight>
            {savedSearches.length === 0 ? <Empty icon="fa-bookmark" title="No saved searches" /> : (
              <table>
                <tbody>
                  {savedSearches.map((s: any) => (
                    <tr>
                      <td>
                        <a href={`/candidates?q=${encodeURIComponent(s.query)}&mode=${s.mode}`} class="cell-main" style="text-decoration:none">{s.name}</a>
                        <div class="cell-sub mono tiny">{truncate(s.query, 40)}</div>
                      </td>
                      <td class="nowrap"><Badge tone={s.mode === 'semantic' ? 'violet' : 'brand'}>{s.mode}</Badge></td>
                      <td>
                        <button class="btn ghost sm" data-act={`/api/saved-searches/${s.id}`} data-method="DELETE" data-reload="1" title="Delete">
                          <i class="fa-solid fa-trash" style="font-size:10px"></i>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Recent searches" tight>
            {audit.length === 0 ? <Empty icon="fa-clock-rotate-left" title="No search history" /> : (
              <table>
                <tbody>
                  {audit.map((a: any) => (
                    <tr>
                      <td>
                        <div class="small mono">{truncate(a.query || '—', 34)}</div>
                        <div class="cell-sub">{a.result_count} results · {a.duration_ms}ms</div>
                      </td>
                      <td class="tiny muted nowrap">{relTime(a.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Search syntax">
            <div class="small muted" style="line-height:1.75">
              <div><span class="kbd">react AND node</span> both required</div>
              <div><span class="kbd">react OR vue</span> either</div>
              <div><span class="kbd">NOT manager</span> exclude</div>
              <div><span class="kbd">"design system"</span> exact phrase</div>
              <div><span class="kbd">skill:python</span> field prefix</div>
              <div><span class="kbd">(a OR b) AND c</span> grouping</div>
              <div style="margin-top:8px">Fields: skill, title, employer, education, location, resume</div>
            </div>
          </Card>
        </div>
      </div>
    </Layout>
  )
}

/* ---------------------------------------------------------------- profile */
export const CandidateDetailPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { candidate: c, applications, resumes, notes, messages, tags, pools, consents, history, interviews, allTags, allPools, aiSummary } = data
  const totalApps = applications.length
  const hired = applications.filter((a: any) => a.status === 'hired').length

  return (
    <Layout user={user} active="/candidates" title={`${c.first_name} ${c.last_name}`}>
      <PageHead
        title={`${c.first_name} ${c.last_name}`}
        sub={[c.headline, c.location, c.experience_years ? `${c.experience_years} years experience` : null]
          .filter(Boolean).join(' · ')}
        actions={
          <>
            {c.status === 'merged' ? <Badge tone="slate">Merged into #{c.merged_into_id}</Badge> : null}
            <Badge tone={c.consent_status === 'opt_in' ? 'ok' : c.consent_status === 'opt_out' ? 'danger' : 'slate'} dot>
              Consent: {titleCase(c.consent_status)}
            </Badge>
            {can(user.role, 'message.send') ? (
              <a class="btn" href={`/communications?candidate=${c.id}`}><i class="fa-solid fa-envelope"></i> Message</a>
            ) : null}
            {can(user.role, 'candidate.edit') ? (
              <button class="btn" onclick="openModal('edit-modal')"><i class="fa-solid fa-pen"></i> Edit</button>
            ) : null}
            {can(user.role, 'candidate.merge') ? (
              <a class="btn" href={`/candidates/duplicates?candidate=${c.id}`}><i class="fa-solid fa-clone"></i> Check duplicates</a>
            ) : null}
          </>
        }
      />

      {c.mergedFrom && c.mergedFrom.length ? (
        <div class="spec-note mb16">
          <i class="fa-solid fa-code-merge"></i> This profile absorbed {c.mergedFrom.length} merged record
          {c.mergedFrom.length > 1 ? 's' : ''}: {c.mergedFrom.map((m: any) => `#${m.id} ${m.first_name} ${m.last_name}`).join(', ')}. History is preserved.
        </div>
      ) : null}

      <div class="grid g4 mb16">
        <Stat label="Applications" value={totalApps} meta={`${applications.filter((a: any) => a.status === 'active').length} active`} />
        <Stat label="Hires" value={hired} meta={hired ? 'Previously hired' : 'No hires yet'} />
        <Stat label="Interviews" value={interviews.length} meta={`${interviews.filter((i: any) => i.status === 'feedback_complete').length} completed`} />
        <Stat label="In talent pools" value={pools.length} meta={`${tags.length} tags`} />
      </div>

      <div class="split">
        <div class="stack">
          <Card title="Profile" actions={
            can(user.role, 'candidate.edit') ? (
              <button class="btn ghost sm" onclick="openModal('edit-modal')"><i class="fa-solid fa-pen"></i></button>
            ) : null
          }>
            <Meta items={[
              ['Email', <a href={`mailto:${c.email}`}>{c.email}</a>],
              ['Phone', c.phone || '—'],
              ['Location', c.location || '—'],
              ['Current employer', c.current_employer || '—'],
              ['Experience', c.experience_years ? `${c.experience_years} years` : '—'],
              ['Notice period', c.notice_period_days ? `${c.notice_period_days} days` : '—'],
              ['Expected salary', c.expected_salary ? money(c.expected_salary, c.salary_currency || 'USD') : '—'],
              ['Availability', c.availability || '—'],
              ['Source', c.source || '—'],
              ['Added', fmtDate(c.created_at)]
            ]} />
            {c.skills.length ? (
              <>
                <hr />
                <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-bottom:6px">Skills</div>
                <div>{c.skills.map((s: string) => <span class="skill">{s}</span>)}</div>
              </>
            ) : null}
            {c.education_list.length ? (
              <>
                <hr />
                <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-bottom:6px">Education</div>
                <div class="small">{c.education_list.map((e: string) => <div>· {e}</div>)}</div>
              </>
            ) : null}
            {c.summary ? <><hr /><p class="small" style="line-height:1.65">{c.summary}</p></> : null}
            {tags.length ? (
              <>
                <hr />
                <div class="row wrap" style="gap:5px">
                  {tags.map((t: any) => <span class={`badge ${t.color}`}>{t.name}</span>)}
                </div>
              </>
            ) : null}
          </Card>

          <Card title="Applications & stage history" sub={`${totalApps} applications across requisitions`} tight>
            {totalApps === 0 ? <Empty icon="fa-file-lines" title="No applications" /> : (
              <table>
                <thead><tr><th>Requisition</th><th>Stage</th><th>Status</th><th>Applied</th><th></th></tr></thead>
                <tbody>
                  {applications.map((a: any) => (
                    <tr>
                      <td>
                        <a href={`/jobs/${a.job_id}`} class="cell-main" style="text-decoration:none">{a.job_title}</a>
                        <div class="cell-sub">{a.job_code} · {a.source}</div>
                      </td>
                      <td><StageBadge stage={a.stage} /></td>
                      <td><AppStatus status={a.status} />{a.rejection_reason ? <div class="cell-sub">{a.rejection_reason}</div> : null}</td>
                      <td class="tiny muted nowrap">{fmtDate(a.applied_at)}</td>
                      <td class="nowrap"><a class="btn sm" href={`/applications/${a.id}`}>Open</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Unified candidate timeline" sub="Audited stage and status changes across every application" tight>
            {history.length === 0 ? <Empty icon="fa-clock-rotate-left" title="No history yet" /> : (
              <div class="card-body">
                <Timeline items={history.map((h: any) => ({
                  title: `${titleCase(h.to_stage)}${h.from_stage ? ` from ${titleCase(h.from_stage)}` : ''}`,
                  meta: `${h.job_title} · ${fmtDateTime(h.created_at)} · ${h.actor_name || 'System'}`,
                  tone: h.to_status === 'rejected' ? 'danger' : h.to_status === 'hired' ? 'ok' : h.to_status === 'on_hold' ? 'warn' : '',
                  body: h.reason || (h.to_status !== 'active' ? `Status: ${titleCase(h.to_status)}` : null)
                }))} />
              </div>
            )}
          </Card>

          <Card title="Communication history" tight sub={`${messages.length} messages`}
            actions={<a class="btn ghost sm" href={`/communications?candidate=${c.id}`}>Send</a>}>
            {messages.length === 0 ? <Empty icon="fa-envelope-open" title="No messages sent" /> : (
              <table>
                <thead><tr><th>Subject</th><th>Status</th><th>Sent</th></tr></thead>
                <tbody>
                  {messages.slice(0, 8).map((m: any) => (
                    <tr>
                      <td>
                        <div class="cell-main small">{truncate(m.subject, 46)}</div>
                        <div class="cell-sub">{m.template_name || 'Custom'} · {m.to_address}</div>
                      </td>
                      <td><MsgStatus status={m.status} />{m.error ? <div class="cell-sub" title={m.error}>{truncate(m.error, 22)}</div> : null}</td>
                      <td class="tiny muted nowrap">{m.sent_at ? relTime(m.sent_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Notes" tight>
            <div class="card-body" style="border-bottom:1px solid var(--line-soft)">
              <form data-api={`/api/candidates/${c.id}/notes`} data-method="post" data-reload="1" class="row" style="gap:8px">
                <input type="text" name="body" placeholder="Add a note visible to the recruiting team…" required />
                <button class="btn primary" type="submit"><i class="fa-solid fa-plus"></i></button>
              </form>
            </div>
            {notes.length === 0 ? <Empty icon="fa-note-sticky" title="No notes" /> : (
              <table>
                <tbody>
                  {notes.map((n: any) => (
                    <tr>
                      <td>
                        <div class="small">{n.body}</div>
                        <div class="cell-sub">{n.author_name || 'Unknown'} · {relTime(n.created_at)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div class="stack">
          {aiSummary ? (
            <div class="ai-panel">
              <header>
                <i class="fa-solid fa-wand-magic-sparkles" style="color:#7c3aed"></i>
                <b>AI candidate summary</b>
              </header>
              <div class="card-body">
                <div class="row between mb8">
                  <span class="badge violet">fit {aiSummary.output.fit_score}%</span>
                  <Confidence value={aiSummary.confidence} />
                </div>
                <p class="small" style="line-height:1.6">{aiSummary.output.summary}</p>
                {aiSummary.evidence.filter((e: any) => e.status !== 'missing').length ? (
                  <>
                    <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-top:10px">Evidence</div>
                    {aiSummary.evidence.filter((e: any) => e.status !== 'missing').slice(0, 4).map((e: any) => (
                      <div class="evidence">
                        <div class="src">{e.status} · {e.source}</div>
                        <b>{e.criterion}</b> — {truncate(e.quote || '', 120)}
                      </div>
                    ))}
                  </>
                ) : null}
                {aiSummary.missing_information.length ? (
                  <>
                    <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-top:10px">Missing information</div>
                    <div class="small muted" style="line-height:1.7">{aiSummary.missing_information.map((m: string) => <div>· {m}</div>)}</div>
                  </>
                ) : null}
                <div class="tiny muted mt8" style="border-top:1px solid #ede9fe;padding-top:8px">
                  <i class="fa-solid fa-circle-info"></i> Advisory only — a recruiter must review. Engine: <span class="mono">{aiSummary.engine}</span>
                </div>
              </div>
            </div>
          ) : null}

          <Card title="Resumes" tight sub={`${resumes.length} on file`}>
            {resumes.length === 0 ? <Empty icon="fa-file" title="No resume" /> : (
              <table>
                <tbody>
                  {resumes.map((r: any) => (
                    <tr>
                      <td>
                        <div class="cell-main small">{r.filename}{r.is_primary ? <span class="badge brand" style="margin-left:6px">primary</span> : null}</div>
                        <div class="cell-sub">
                          {r.status === 'screening_ready' ? `parsed · confidence ${Math.round((r.parse_confidence || 0) * 100)}%` : r.last_error || 'processing'}
                        </div>
                      </td>
                      <td><ResumeStatus status={r.status} /></td>
                      <td>
                        {['failed', 'dead_letter'].includes(r.status) ? (
                          <button class="btn sm" data-act={`/api/resumes/${r.id}/retry`} data-reload="1">Retry</button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Talent pools" tight>
            <div class="card-body">
              {pools.length === 0 ? <div class="small muted">Not in any pool.</div> : (
                pools.map((p: any) => (
                  <div class="row between" style="margin-bottom:6px">
                    <a href={`/pools/${p.id}`} class="small">{p.name}</a>
                    <Badge tone={p.re_engagement === 'interested' ? 'ok' : p.re_engagement === 'not_interested' ? 'danger' : 'slate'}>
                      {titleCase(p.re_engagement)}
                    </Badge>
                  </div>
                ))
              )}
              <hr />
              <form data-api={`/api/candidates/${c.id}/pools`} data-method="post" data-reload="1" class="row" style="gap:6px">
                <select name="pool_id" style="font-size:12px">
                  {allPools.map((p: any) => <option value={p.id}>{p.name}</option>)}
                </select>
                <button class="btn sm" type="submit"><i class="fa-solid fa-plus"></i></button>
              </form>
            </div>
          </Card>

          <Card title="Consent & privacy">
            {consents.length === 0 ? <div class="small muted">No consent records.</div> : (
              <table>
                <tbody>
                  {consents.map((k: any) => (
                    <tr>
                      <td class="small">{titleCase(k.channel)}</td>
                      <td><Badge tone={k.status === 'opt_in' ? 'ok' : k.status === 'opt_out' ? 'danger' : 'slate'}>{titleCase(k.status)}</Badge></td>
                      <td class="tiny muted">{relTime(k.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <hr />
            <Meta items={[['Retention until', c.retention_until ? fmtDate(c.retention_until) : '—']]} />
            <div class="row wrap mt8" style="gap:6px">
              <button class="btn sm" data-act={`/api/candidates/${c.id}/dsr`} data-body='{"type":"export"}' data-reload="1">
                <i class="fa-solid fa-download"></i> Export data
              </button>
              {can(user.role, 'candidate.delete') ? (
                <button class="btn sm danger" data-act={`/api/candidates/${c.id}/dsr`} data-body='{"type":"delete"}' data-prompt="Reason for deletion (recorded in audit)" data-reload="1">
                  <i class="fa-solid fa-user-slash"></i> Erase
                </button>
              ) : null}
            </div>
          </Card>

          <Card title="Tags">
            <div class="row wrap" style="gap:5px;margin-bottom:8px">
              {tags.map((t: any) => <span class={`badge ${t.color}`}>{t.name}</span>)}
              {tags.length === 0 ? <span class="small muted">No tags</span> : null}
            </div>
            <form data-api={`/api/candidates/${c.id}/tags`} data-method="post" data-reload="1" class="row" style="gap:6px">
              <select name="tag_id" style="font-size:12px">
                {allTags.map((t: any) => <option value={t.id}>{t.name}</option>)}
              </select>
              <button class="btn sm" type="submit"><i class="fa-solid fa-tag"></i></button>
            </form>
          </Card>
        </div>
      </div>

      <dialog class="modal" id="edit-modal">
        <header><h3>Edit candidate</h3><button class="btn ghost sm" onclick="closeModal('edit-modal')"><i class="fa-solid fa-xmark"></i></button></header>
        <form data-api={`/api/candidates/${c.id}`} data-method="PATCH" data-reload="1">
          <div class="body">
            <div class="form-grid">
              <Field label="First name"><input type="text" name="first_name" value={c.first_name} /></Field>
              <Field label="Last name"><input type="text" name="last_name" value={c.last_name} /></Field>
              <Field label="Email"><input type="email" name="email" value={c.email} /></Field>
              <Field label="Phone"><input type="text" name="phone" value={c.phone || ''} /></Field>
              <Field label="Location"><input type="text" name="location" value={c.location || ''} /></Field>
              <Field label="Headline"><input type="text" name="headline" value={c.headline || ''} /></Field>
              <Field label="Current employer"><input type="text" name="current_employer" value={c.current_employer || ''} /></Field>
              <Field label="Experience (years)"><input type="number" name="experience_years" value={c.experience_years || ''} /></Field>
              <Field label="Notice period (days)"><input type="number" name="notice_period_days" value={c.notice_period_days || ''} /></Field>
              <Field label="Expected salary"><input type="number" name="expected_salary" value={c.expected_salary || ''} /></Field>
              <Field label="Consent status">
                <select name="consent_status">
                  {['opt_in', 'opt_out', 'unknown'].map((s) => <option value={s} selected={c.consent_status === s}>{titleCase(s)}</option>)}
                </select>
              </Field>
              <Field label="Education"><input type="text" name="education" value={c.education || ''} /></Field>
              <Field label="Summary" full><textarea name="summary" rows={3}>{c.summary || ''}</textarea></Field>
            </div>
          </div>
          <footer>
            <button class="btn" type="button" onclick="closeModal('edit-modal')">Cancel</button>
            <button class="btn primary" type="submit">Save changes</button>
          </footer>
        </form>
      </dialog>
    </Layout>
  )
}

/* ------------------------------------------------------------ duplicates */
export const DuplicatesPage = ({ user, pairs, stats }: { user: AuthUser; pairs: any[]; stats: any }) => (
  <Layout user={user} active="/candidates/duplicates" title="Duplicate review">
    <PageHead
      title="Duplicate detection & merge"
      sub="Candidates are matched on normalised email, phone, name similarity and resume text overlap. Reviewing a pair shows exactly what will move before anything changes — records are never deleted."
      actions={
        <button class="btn primary" data-act="/api/candidates/duplicates/refresh" data-reload="1">
          <i class="fa-solid fa-rotate"></i> Re-scan for duplicates
        </button>
      }
    />

    <div class="grid g4 mb16">
      <Stat label="Pending review" value={stats.pending} meta="Pairs awaiting a decision" />
      <Stat label="High confidence" value={stats.high} meta="Score ≥ 0.7" />
      <Stat label="Merged" value={stats.merged} meta="Canonical records" />
      <Stat label="Ignored" value={stats.ignored} meta="Reviewed, not duplicates" />
    </div>

    <div class="danger-note mb16">
      <b>Merge safety:</b> the losing record is marked <span class="mono">merged</span> and pointed at the canonical candidate. A full snapshot of both
      profiles and the moved-record counts is written to <span class="mono">candidate_merges</span>, and the merge can be reverted.
    </div>

    <div class="stack">
      {pairs.length === 0 ? (
        <Card><Empty icon="fa-clone" title="No duplicate pairs pending" sub="Run a re-scan after new imports." /></Card>
      ) : pairs.map((p: any) => (
        <Card key={p.id} title={`Possible duplicate · score ${p.score}`} sub={p.signals.map((s: any) => s.detail).join(' · ')}>
          <div class="grid g2">
            {[p.primary, p.duplicate].map((c: any, i) => (
              <div style="border:1px solid var(--line);border-radius:9px;padding:12px">
                <div class="row between mb8">
                  <Person first={c.first_name} last={c.last_name} sub={c.headline} />
                  <Badge tone={i === 0 ? 'brand' : 'slate'}>{i === 0 ? 'Canonical (older)' : 'Candidate to merge'}</Badge>
                </div>
                <table>
                  <tbody>
                    <tr><td class="tiny muted" style="width:88px">Email</td><td class="small mono">{c.email}</td></tr>
                    <tr><td class="tiny muted">Phone</td><td class="small mono">{c.phone || '—'}</td></tr>
                    <tr><td class="tiny muted">Employer</td><td class="small">{c.current_employer || '—'}</td></tr>
                    <tr><td class="tiny muted">Education</td><td class="small">{truncate(c.education || '—', 40)}</td></tr>
                    <tr><td class="tiny muted">Location</td><td class="small">{c.location || '—'}</td></tr>
                    <tr><td class="tiny muted">Apps</td><td class="small">{c.application_count || 0}</td></tr>
                    <tr><td class="tiny muted">Created</td><td class="small">{fmtDate(c.created_at)}</td></tr>
                  </tbody>
                </table>
              </div>
            ))}
          </div>

          <div class="row wrap mt16" style="gap:8px">
            <button class="btn primary" data-act={`/api/candidates/merge-preview`} data-method="POST" data-body={JSON.stringify({ primary_id: p.primary_id, duplicate_id: p.duplicate_id })} data-onDone="showMergePreview">
              <i class="fa-solid fa-code-merge"></i> Preview merge
            </button>
            <button
              class="btn" data-act={`/api/candidates/merge`} data-method="POST"
              data-body={JSON.stringify({ primary_id: p.primary_id, duplicate_id: p.duplicate_id })}
              data-confirm={`Merge candidate #${p.duplicate_id} into #${p.primary_id}? History is preserved and this can be reverted.`}
              data-reload="1"
            >
              <i class="fa-solid fa-code-merge"></i> Merge into #{p.primary_id}
            </button>
            <button class="btn ghost" data-act={`/api/candidates/duplicates/${p.id}/ignore`} data-reload="1">
              <i class="fa-solid fa-ban"></i> Not a duplicate
            </button>
            <div style="flex:1"></div>
            <a class="btn ghost sm" href={`/candidates/${p.primary_id}`}>View #{p.primary_id}</a>
            <a class="btn ghost sm" href={`/candidates/${p.duplicate_id}`}>View #{p.duplicate_id}</a>
          </div>
        </Card>
      ))}
    </div>

    <dialog class="modal" id="merge-preview-modal">
      <header><h3>Merge preview</h3><button class="btn ghost sm" onclick="closeModal('merge-preview-modal')"><i class="fa-solid fa-xmark"></i></button></header>
      <div class="body" id="merge-preview-body"></div>
      <footer><button class="btn" onclick="closeModal('merge-preview-modal')">Close</button></footer>
    </dialog>

    <script dangerouslySetInnerHTML={{ __html: `
      window.showMergePreview = function(out) {
        var b = document.getElementById('merge-preview-body');
        var rows = Object.entries(out.will_move).map(function(kv){
          return '<tr><td class="small">' + kv[0].replace(/_/g,' ') + '</td><td class="num small">' + kv[1] + '</td></tr>';
        }).join('');
        var conflicts = out.duplicate_applications_on_same_job.length
          ? '<div class="warn-note mt16">' + out.conflict_note + '<br>' +
            out.duplicate_applications_on_same_job.map(function(c){ return '· ' + c.title; }).join('<br>') + '</div>'
          : '<div class="spec-note mt16">' + out.conflict_note + '</div>';
        b.innerHTML =
          '<p class="small"><b>' + out.duplicate.first_name + ' ' + out.duplicate.last_name + '</b> will be merged into <b>' +
          out.primary.first_name + ' ' + out.primary.last_name + '</b> (#' + out.primary.id + ').</p>' +
          '<table class="mt16"><thead><tr><th>Records moving</th><th class="num">Count</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          conflicts +
          '<div class="small muted mt16">Reversible: ' + (out.reversible ? 'yes' : 'no') + '</div>';
        openModal('merge-preview-modal');
      };
    ` }} />
  </Layout>
)
