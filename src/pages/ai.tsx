import { Layout } from '../components/layout'
import { PageHead, Card, Stat, Empty, Badge, Field, Bars } from '../components/ui'
import type { AuthUser } from '../lib/auth'
import { can } from '../lib/rbac'
import { money, fmtDateTime, relTime, titleCase } from '../lib/util'
import { FEATURE_LABELS } from '../modules/ai/types'

/* --------------------------------------------------------------- shared bits */
const AI_TABS = [
  { href: '/ai', label: 'Dashboard' },
  { href: '/ai/providers', label: 'Providers' },
  { href: '/ai/models', label: 'Models' },
  { href: '/ai/features', label: 'Feature routing' },
  { href: '/ai/usage', label: 'Usage & cost' },
  { href: '/ai/logs', label: 'Request logs' },
  { href: '/ai/security', label: 'Security' }
]

const AiTabs = ({ active }: { active: string }) => (
  <div class="tabs">
    {AI_TABS.map((t) => (
      <a href={t.href} class={t.href === active ? 'active' : ''}>{t.label}</a>
    ))}
  </div>
)

const STATUS_TONE: Record<string, string> = {
  connected: 'ok', error: 'danger', not_configured: 'slate', disabled: 'slate'
}
const ProviderStatus = ({ status }: { status: string }) => (
  <Badge tone={STATUS_TONE[status] || 'slate'} dot>{titleCase(status.replace('_', ' '))}</Badge>
)

const fmtNum = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n))

const money4 = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '—'
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

/* ================================================================ dashboard */
export const AiDashboardPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { providers, features, usage, counts, settings } = data
  const live = providers.filter((p: any) => p.enabled)
  const unrouted = features.filter((f: any) => !f.provider_id)
  const t = usage.totals

  return (
    <Layout user={user} active="/ai" title="AI integration">
      <PageHead
        title="AI integration"
        sub="One gateway, twelve providers, per-feature model routing. Every call is audited, costed from real token counts, and subject to the privacy policy below."
        actions={
          <>
            <a class="btn" href="/ai/providers"><i class="fa-solid fa-plug"></i> Providers</a>
            {can(user.role, 'ai.configure') ? <a class="btn primary" href="/ai/features"><i class="fa-solid fa-diagram-project"></i> Route a feature</a> : null}
          </>
        }
      />
      <AiTabs active="/ai" />

      <div class="grid g4 mb16">
        <Stat label="Providers enabled" value={`${counts.enabledProviders} / ${counts.totalProviders}`}
          meta={`${providers.filter((p: any) => p.has_key || p.local_only).length} with credentials`} />
        <Stat label="Features routed" value={`${counts.routedFeatures} / ${features.length}`}
          meta={unrouted.length ? `${unrouted.length} unrouted` : 'all routed'}
          tone={unrouted.length ? 'var(--warn)' : undefined} />
        <Stat label="Requests (30d)" value={fmtNum(t.requests)} meta={`${t.failures} failed`} />
        <Stat label="Estimated cost (30d)" value={money4(t.costUsd)} meta={`${fmtNum(t.totalTokens)} tokens`} />
      </div>

      <div class="split mb16">
        <Card title="Provider health" sub="Credential validation runs against each provider's live API"
          actions={<a class="btn ghost sm" href="/ai/providers">Manage</a>} tight>
          {live.length === 0 ? (
            <Empty icon="fa-plug-circle-exclamation" title="No provider enabled"
              sub="Add an API key to at least one provider to turn on AI features." />
          ) : (
            <div class="table-wrap">
              <table>
                <thead><tr><th>Provider</th><th>Status</th><th>Key</th><th>Models</th><th>Last check</th></tr></thead>
                <tbody>
                  {live.map((p: any) => (
                    <tr>
                      <td class="small"><i class={`${p.logo || 'fa-solid fa-robot'} muted`} /> <b>{p.name}</b>
                        {p.local_only ? <Badge tone="info">local</Badge> : null}</td>
                      <td><ProviderStatus status={p.status} /></td>
                      <td class="small muted">{p.has_key ? p.api_key_hint : (p.local_only ? 'not required' : 'missing')}</td>
                      <td class="small">{p.model_count}</td>
                      <td class="small muted nowrap">{p.last_check_at ? relTime(p.last_check_at) : 'never'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Privacy & safety" sub="Enforced inside the gateway">
          <div class="stack">
            <div class="row" style="justify-content:space-between">
              <span class="small">PII policy</span>
              <Badge tone={settings.pii_policy === 'allow' ? 'warn' : 'ok'}>{settings.pii_policy}</Badge>
            </div>
            <div class="row" style="justify-content:space-between">
              <span class="small">External calls</span>
              <Badge tone={settings.external_calls_enabled === '0' ? 'danger' : 'ok'}>
                {settings.external_calls_enabled === '0' ? 'disabled' : 'allowed'}
              </Badge>
            </div>
            <div class="row" style="justify-content:space-between">
              <span class="small">Retries per provider</span>
              <span class="small"><b>{settings.max_retries}</b></span>
            </div>
            <div class="row" style="justify-content:space-between">
              <span class="small">Log retention</span>
              <span class="small"><b>{settings.request_log_retention_days}</b> days</span>
            </div>
            <p class="tiny muted" style="margin:4px 0 0">
              AI output is advisory. It never rejects, hires, or makes a final employment decision.
            </p>
            {can(user.role, 'ai.configure') ? <a class="btn ghost sm" href="/ai/security">Security settings</a> : null}
          </div>
        </Card>
      </div>

      <Card title="Feature routing" sub="Each ATS capability can use a different provider and model"
        actions={<a class="btn ghost sm" href="/ai/features">Configure</a>} tight>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Feature</th><th>Provider</th><th>Model</th><th>Fallback</th><th>State</th></tr></thead>
            <tbody>
              {features.map((f: any) => (
                <tr>
                  <td class="small"><b>{FEATURE_LABELS[f.feature as keyof typeof FEATURE_LABELS]?.label || f.feature}</b></td>
                  <td class="small">{f.provider_name || <span class="muted">not routed</span>}</td>
                  <td class="small mono">{f.model_id || '—'}</td>
                  <td class="small muted">{f.fallback_name || '—'}</td>
                  <td>{f.enabled
                    ? <Badge tone="ok" dot>on</Badge>
                    : <Badge tone="slate" dot>off</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Layout>
  )
}

/* ================================================================ providers */
export const AiProvidersPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { providers } = data
  const editable = can(user.role, 'ai.configure')

  return (
    <Layout user={user} active="/ai" title="AI providers">
      <PageHead
        title="AI providers"
        sub="API keys are encrypted at rest with AES-GCM and never returned to the browser — only the last four characters are shown. Connection tests hit each provider's real API."
      />
      <AiTabs active="/ai/providers" />

      {!editable ? (
        <div class="card mb16" style="padding:14px">
          <span class="small muted"><i class="fa-solid fa-lock" /> Read-only: only administrators can change provider credentials.</span>
        </div>
      ) : null}

      <div class="grid g2">
        {providers.map((p: any) => (
          <Card
            title={p.name}
            sub={p.local_only ? 'Local inference — no API cost' : p.base_url}
            actions={<ProviderStatus status={p.status} />}
          >
            {editable ? (
              <form data-api="/api/ai/providers" data-method="post" data-reload="1" class="stack">
                <input type="hidden" name="id" value={p.id} />
                <input type="hidden" name="slug" value={p.slug} />
                <div class="grid g2">
                  <Field label="Display name">
                    <input name="name" value={p.name} required />
                  </Field>
                  <Field label="Base URL">
                    <input name="base_url" value={p.base_url} required />
                  </Field>
                </div>
                <div class="grid g2">
                  <Field label="API key" help={p.has_key ? `Stored: ${p.api_key_hint}` : (p.local_only ? 'Not required for local Ollama' : 'Not configured')}>
                    <input type="password" name="api_key" autocomplete="new-password"
                      placeholder={p.has_key ? 'Leave blank to keep current key' : 'Paste API key'} />
                  </Field>
                  <Field label="Default model" help="Used when a feature does not name a model">
                    <input name="default_model" value={p.default_model || ''} placeholder="e.g. gpt-4o-mini" />
                  </Field>
                </div>
                <div class="grid g2">
                  <Field label="Organization ID" help="OpenAI / Azure only">
                    <input name="org_id" value={p.org_id || ''} placeholder="optional" />
                  </Field>
                  <Field label="Status">
                    <label class="row" style="gap:8px;align-items:center;padding-top:6px">
                      <input type="checkbox" name="enabled" value="1" checked={p.enabled === 1} />
                      <span class="small">Enabled for routing</span>
                    </label>
                  </Field>
                </div>
                <div class="row" style="gap:8px">
                  <button class="btn primary" type="submit"><i class="fa-solid fa-floppy-disk"></i> Save</button>
                </div>
              </form>
            ) : (
              <div class="stack">
                <div class="row" style="justify-content:space-between"><span class="small muted">Key</span><span class="small">{p.has_key ? p.api_key_hint : '—'}</span></div>
                <div class="row" style="justify-content:space-between"><span class="small muted">Models</span><span class="small">{p.model_count}</span></div>
                <div class="row" style="justify-content:space-between"><span class="small muted">Enabled</span><span class="small">{p.enabled ? 'yes' : 'no'}</span></div>
              </div>
            )}

            {editable ? (
              <div class="row wrap" style="gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
                <button class="btn sm" data-act={`/api/ai/providers/${p.id}/test`} data-reload="1">
                  <i class="fa-solid fa-vial"></i> Test connection
                </button>
                <button class="btn sm" data-act={`/api/ai/providers/${p.id}/discover`} data-reload="1">
                  <i class="fa-solid fa-radar"></i> Discover models
                </button>
                <button class="btn sm" data-act={`/api/ai/providers/${p.id}`} data-method="PATCH"
                  data-body={JSON.stringify({ enabled: p.enabled ? 0 : 1 })} data-reload="1">
                  {p.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
            ) : null}

            {p.last_error ? (
              <div class="danger-note small" style="margin-top:10px">
                <b>Last error:</b> {p.last_error}
              </div>
            ) : null}
            {p.last_check_at ? (
              <p class="tiny muted" style="margin:8px 0 0">Last checked {fmtDateTime(p.last_check_at)}</p>
            ) : null}
          </Card>
        ))}
      </div>
    </Layout>
  )
}

/* =================================================================== models */
export const AiModelsPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { models, providers } = data
  const editable = can(user.role, 'ai.configure')
  const byProvider = providers.filter((p: any) => p.enabled || p.has_key || p.local_only)

  return (
    <Layout user={user} active="/ai" title="AI models">
      <PageHead
        title="Model management"
        sub="Models are discovered from each provider's API where one exists. For providers without a listing endpoint (Perplexity, xAI, Azure) register model IDs manually. Prices are USD per 1M tokens and drive cost estimates."
      />
      <AiTabs active="/ai/models" />

      <div class="grid g4 mb16">
        <Stat label="Models registered" value={models.length} />
        <Stat label="Discovered" value={models.filter((m: any) => m.source === 'discovered').length} meta="from provider APIs" />
        <Stat label="Manual" value={models.filter((m: any) => m.source === 'custom').length} meta="admin-registered" />
        <Stat label="Priced" value={models.filter((m: any) => m.input_price !== null).length} meta="cost estimate available" />
      </div>

      {editable ? (
        <Card title="Register a model manually" sub="Use for providers with no model-listing endpoint, or for a model released ahead of discovery" >
          <form data-api="/api/ai/models" data-method="post" data-reload="1" class="stack">
            <div class="grid g4">
              <Field label="Provider">
                <select name="provider_id" required>
                  <option value="">Select…</option>
                  {byProvider.map((p: any) => <option value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Model ID" help="Exactly as the provider expects it">
                <input name="model_id" required placeholder="e.g. claude-sonnet-4-5" />
              </Field>
              <Field label="Context window" help="tokens, optional">
                <input name="context_window" type="number" min="0" placeholder="200000" />
              </Field>
              <Field label="Capabilities">
                <div class="row wrap" style="gap:12px;padding-top:6px">
                  <label class="row tiny" style="gap:5px"><input type="checkbox" name="vision" /> Vision</label>
                  <label class="row tiny" style="gap:5px"><input type="checkbox" name="tools" /> Tools</label>
                  <label class="row tiny" style="gap:5px"><input type="checkbox" name="streaming" checked /> Stream</label>
                </div>
              </Field>
            </div>
            <div class="grid g2">
              <Field label="Input price" help="USD per 1M input tokens">
                <input name="input_price" type="number" step="0.0001" min="0" placeholder="3.00" />
              </Field>
              <Field label="Output price" help="USD per 1M output tokens">
                <input name="output_price" type="number" step="0.0001" min="0" placeholder="15.00" />
              </Field>
            </div>
            <div class="row"><button class="btn primary" type="submit"><i class="fa-solid fa-plus"></i> Register model</button></div>
          </form>
        </Card>
      ) : null}

      <div class="mb16" />

      <Card title="All models" sub={`${models.length} registered`} tight>
        {models.length === 0 ? (
          <Empty icon="fa-microchip" title="No models yet"
            sub="Run Discover models on a provider, or register one manually above." />
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Provider</th><th>Model</th><th>Context</th><th>In $/1M</th><th>Out $/1M</th>
                  <th>Capabilities</th><th>Source</th><th></th>
                </tr>
              </thead>
              <tbody>
                {models.map((m: any) => (
                  <tr>
                    <td class="small">{m.provider_name}</td>
                    <td class="small"><b>{m.name}</b><div class="tiny muted mono">{m.model_id}</div></td>
                    <td class="small nowrap">{m.context_window ? fmtNum(m.context_window) : '—'}</td>
                    <td class="small nowrap">{m.input_price === null ? '—' : money4(m.input_price)}</td>
                    <td class="small nowrap">{m.output_price === null ? '—' : money4(m.output_price)}</td>
                    <td class="small">
                      <div class="row wrap" style="gap:4px">
                        {m.vision ? <Badge tone="info">vision</Badge> : null}
                        {m.tools ? <Badge tone="info">tools</Badge> : null}
                        {m.streaming ? <Badge tone="slate">stream</Badge> : null}
                        {m.availability !== 'available' ? <Badge tone="warn">{m.availability}</Badge> : null}
                      </div>
                    </td>
                    <td class="small muted">{m.source}</td>
                    <td class="nowrap">
                      {editable && m.source !== 'discovered' ? (
                        <button class="btn ghost sm" data-act={`/api/ai/models/${m.id}`} data-method="DELETE"
                          data-confirm={`Remove ${m.model_id}?`} data-reload="1">
                          <i class="fa-solid fa-trash"></i>
                        </button>
                      ) : null}
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

/* =========================================================== feature routing */
export const AiFeaturesPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { features, providers, models } = data
  const editable = can(user.role, 'ai.configure')
  const usable = providers.filter((p: any) => p.enabled)

  return (
    <Layout user={user} active="/ai" title="AI feature routing">
      <PageHead
        title="Feature routing"
        sub="Assign a provider, model and fallback to each ATS capability. A feature with no route returns a clear 409 rather than silently failing."
      />
      <AiTabs active="/ai/features" />

      <div class="grid g2">
        {features.map((f: any) => {
          const label = FEATURE_LABELS[f.feature as keyof typeof FEATURE_LABELS]
          const providerModels = models.filter((m: any) => m.provider_id === f.provider_id)
          return (
            <Card
              title={label?.label || f.feature}
              sub={label?.hint}
              actions={f.enabled ? <Badge tone="ok" dot>on</Badge> : <Badge tone="slate" dot>off</Badge>}
            >
              {editable ? (
                <form data-api={`/api/ai/features/${f.feature}`} data-method="post" data-reload="1" class="stack">
                  <div class="grid g2">
                    <Field label="Provider">
                      <select name="provider_id">
                        <option value="">Not routed</option>
                        {usable.map((p: any) => (
                          <option value={p.id} selected={f.provider_id === p.id}>{p.name}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Model" help={providerModels.length ? `${providerModels.length} known` : 'register models first'}>
                      <input name="model_id" value={f.model_id || ''} placeholder="model id" />
                    </Field>
                  </div>
                  <div class="grid g2">
                    <Field label="Fallback provider" help="Used when the primary fails">
                      <select name="fallback_provider_id">
                        <option value="">None</option>
                        {usable.filter((p: any) => p.id !== f.provider_id).map((p: any) => (
                          <option value={p.id} selected={f.fallback_provider_id === p.id}>{p.name}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Fallback model">
                      <input name="fallback_model_id" value={f.fallback_model_id || ''} placeholder="model id" />
                    </Field>
                  </div>
                  <div class="grid g3">
                    <Field label="Temperature" help="0 = deterministic">
                      <input name="temperature" type="number" step="0.1" min="0" max="2" value={f.temperature} />
                    </Field>
                    <Field label="Max tokens">
                      <input name="max_tokens" type="number" min="1" max="32000" value={f.max_tokens} />
                    </Field>
                    <Field label="State">
                      <label class="row" style="gap:8px;align-items:center;padding-top:6px">
                        <input type="checkbox" name="enabled" value="1" checked={f.enabled === 1} />
                        <span class="small">Enabled</span>
                      </label>
                    </Field>
                  </div>
                  <div class="row"><button class="btn primary" type="submit"><i class="fa-solid fa-floppy-disk"></i> Save routing</button></div>
                </form>
              ) : (
                <div class="stack">
                  <div class="row" style="justify-content:space-between"><span class="small muted">Provider</span><span class="small">{f.provider_name || 'not routed'}</span></div>
                  <div class="row" style="justify-content:space-between"><span class="small muted">Model</span><span class="small mono">{f.model_id || '—'}</span></div>
                  <div class="row" style="justify-content:space-between"><span class="small muted">Fallback</span><span class="small">{f.fallback_name || '—'}</span></div>
                </div>
              )}
            </Card>
          )
        })}
      </div>
    </Layout>
  )
}

/* ==================================================================== usage */
export const AiUsagePage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { usage, days } = data
  const t = usage.totals
  const editable = can(user.role, 'ai.configure')

  return (
    <Layout user={user} active="/ai" title="AI usage & cost">
      <PageHead
        title="Usage & cost"
        sub={`Token counts come from each provider's response. Cost is computed from the per-model prices registered under Models — a model without prices shows $0 rather than an invented figure. Window: last ${days} days.`}
        actions={
          <form method="get" action="/ai/usage" class="row" style="gap:8px">
            <select name="days" style="width:120px">
              {[7, 30, 90].map((d) => <option value={d} selected={Number(days) === d}>Last {d}d</option>)}
            </select>
            <button class="btn" type="submit">Apply</button>
          </form>
        }
      />
      <AiTabs active="/ai/usage" />

      <div class="grid g4 mb16">
        <Stat label="API requests" value={fmtNum(t.requests)} meta={`${t.failures} failed`} />
        <Stat label="Total tokens" value={fmtNum(t.totalTokens)}
          meta={`${fmtNum(t.inputTokens)} in / ${fmtNum(t.outputTokens)} out`} />
        <Stat label="Estimated cost" value={money4(t.costUsd)} meta="from registered prices" />
        <Stat label="Avg latency" value={`${fmtNum(t.avgLatency)} ms`} meta="successful calls" />
      </div>

      <div class="split mb16">
        <Card title="Usage by provider" tight>
          {usage.byProvider.length === 0 ? <Empty icon="fa-chart-simple" title="No AI requests yet" /> : (
            <div class="table-wrap">
              <table>
                <thead><tr><th>Provider</th><th>Requests</th><th>Tokens</th><th>Cost</th><th>Avg ms</th></tr></thead>
                <tbody>
                  {usage.byProvider.map((r: any) => (
                    <tr>
                      <td class="small"><b>{r.provider}</b></td>
                      <td class="small">{fmtNum(r.requests)}</td>
                      <td class="small">{fmtNum(r.tokens)}</td>
                      <td class="small">{money4(r.cost)}</td>
                      <td class="small">{fmtNum(r.latency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Tokens by feature">
          {usage.byFeature.length === 0 ? <Empty icon="fa-layer-group" title="No data" /> : (
            <Bars rows={usage.byFeature.map((r: any) => ({
              label: FEATURE_LABELS[r.feature as keyof typeof FEATURE_LABELS]?.label || r.feature,
              value: Number(r.tokens)
            }))} />
          )}
        </Card>
      </div>

      <div class="split mb16">
        <Card title="Model usage" tight>
          {usage.byModel.length === 0 ? <Empty icon="fa-microchip" title="No data" /> : (
            <div class="table-wrap">
              <table>
                <thead><tr><th>Model</th><th>Provider</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead>
                <tbody>
                  {usage.byModel.map((r: any) => (
                    <tr>
                      <td class="small mono">{r.model}</td>
                      <td class="small muted">{r.provider}</td>
                      <td class="small">{fmtNum(r.requests)}</td>
                      <td class="small">{fmtNum(r.tokens)}</td>
                      <td class="small">{money4(r.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Daily volume">
          {usage.daily.length === 0 ? <Empty icon="fa-calendar" title="No data" /> : (
            <Bars rows={usage.daily.map((d: any) => ({ label: d.day.slice(5), value: Number(d.tokens) }))} />
          )}
        </Card>
      </div>

      <Card title="Usage limits & alerts" sub="Checked before every call; a breached limit blocks the request with an explanatory error">
        {editable ? (
          <form data-api="/api/ai/limits" data-method="post" data-reload="1" class="stack mb16">
            <div class="grid g4">
              <Field label="Scope">
                <select name="scope">
                  <option value="global">Global</option>
                  <option value="provider">Provider</option>
                  <option value="feature">Feature</option>
                </select>
              </Field>
              <Field label="Scope reference" help="provider slug or feature key">
                <input name="scope_ref" placeholder="e.g. openai" />
              </Field>
              <Field label="Period">
                <select name="period">
                  <option value="day">Day</option>
                  <option value="week">Week</option>
                  <option value="month" selected>Month</option>
                </select>
              </Field>
              <Field label="Token limit">
                <input name="limit_tokens" type="number" min="1" placeholder="1000000" />
              </Field>
            </div>
            <div class="grid g3">
              <Field label="Cost limit (USD)">
                <input name="limit_cost" type="number" step="0.01" min="0" placeholder="50.00" />
              </Field>
              <Field label="Alert at %">
                <input name="alert_at_pct" type="number" min="1" max="100" value="80" />
              </Field>
              <div class="row" style="align-items:flex-end">
                <button class="btn primary" type="submit"><i class="fa-solid fa-plus"></i> Add limit</button>
              </div>
            </div>
          </form>
        ) : null}

        {usage.limits.length === 0 ? (
          <Empty icon="fa-gauge" title="No limits configured" sub="Without a limit, usage is unbounded." />
        ) : (
          <div class="table-wrap">
            <table>
              <thead><tr><th>Scope</th><th>Ref</th><th>Period</th><th>Token cap</th><th>Cost cap</th><th>Alert at</th><th></th></tr></thead>
              <tbody>
                {usage.limits.map((l: any) => (
                  <tr>
                    <td class="small">{l.scope}</td>
                    <td class="small mono">{l.scope_ref || '—'}</td>
                    <td class="small">{l.period}</td>
                    <td class="small">{l.limit_tokens ? fmtNum(l.limit_tokens) : '—'}</td>
                    <td class="small">{l.limit_cost ? `$${l.limit_cost}` : '—'}</td>
                    <td class="small">{l.alert_at_pct}%</td>
                    <td>
                      {editable ? (
                        <button class="btn ghost sm" data-act={`/api/ai/limits/${l.id}`} data-method="DELETE"
                          data-confirm="Remove this limit?" data-reload="1"><i class="fa-solid fa-trash"></i></button>
                      ) : null}
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

/* ===================================================================== logs */
const LOG_TONE: Record<string, string> = {
  success: 'ok', fallback: 'warn', error: 'danger', blocked: 'slate'
}

export const AiLogsPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { logs, audit, filters, providers } = data

  return (
    <Layout user={user} active="/ai" title="AI request logs">
      <PageHead
        title="Request logs"
        sub="Every gateway call is recorded with provider, model, real token counts, latency and status. Prompts and responses are not stored here; credentials are never logged."
        actions={
          can(user.role, 'ai.configure') ? (
            <button class="btn" data-act="/api/ai/logs/purge" data-confirm="Delete logs older than the retention window?" data-reload="1">
              <i class="fa-solid fa-broom"></i> Purge expired
            </button>
          ) : null
        }
      />
      <AiTabs active="/ai/logs" />

      <form method="get" action="/ai/logs" class="card mb16" style="padding:14px">
        <div class="row wrap" style="gap:8px">
          <select name="provider" style="width:180px">
            <option value="">All providers</option>
            {providers.map((p: any) => (
              <option value={p.slug} selected={filters.provider === p.slug}>{p.name}</option>
            ))}
          </select>
          <select name="feature" style="width:200px">
            <option value="">All features</option>
            {Object.entries(FEATURE_LABELS).map(([k, v]) => (
              <option value={k} selected={filters.feature === k}>{v.label}</option>
            ))}
          </select>
          <select name="status" style="width:150px">
            <option value="">All statuses</option>
            {['success', 'fallback', 'error', 'blocked'].map((s) => (
              <option value={s} selected={filters.status === s}>{titleCase(s)}</option>
            ))}
          </select>
          <button class="btn" type="submit"><i class="fa-solid fa-filter"></i> Filter</button>
          <a class="btn ghost" href="/ai/logs">Reset</a>
        </div>
      </form>

      <Card title="Gateway calls" sub={`${logs.length} most recent`} tight>
        {logs.length === 0 ? <Empty icon="fa-list" title="No requests recorded" /> : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>When</th><th>Feature</th><th>Provider</th><th>Model</th>
                  <th>Tokens</th><th>Cost</th><th>Latency</th><th>Status</th><th>User</th></tr>
              </thead>
              <tbody>
                {logs.map((r: any) => (
                  <tr>
                    <td class="small nowrap muted">{relTime(r.created_at)}</td>
                    <td class="small">{FEATURE_LABELS[r.feature as keyof typeof FEATURE_LABELS]?.label || r.feature}</td>
                    <td class="small"><b>{r.provider_slug}</b></td>
                    <td class="small mono">{r.model_id || '—'}</td>
                    <td class="small nowrap">{fmtNum(r.total_tokens)}</td>
                    <td class="small nowrap">{money4(r.cost_usd)}</td>
                    <td class="small nowrap">{r.latency_ms} ms</td>
                    <td><Badge tone={LOG_TONE[r.status] || 'slate'} dot>{r.status}</Badge></td>
                    <td class="small muted">{r.user_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div class="mb16" />

      <Card title="Configuration audit" sub="Provider, key, model and routing changes" tight>
        {audit.length === 0 ? <Empty icon="fa-shield-halved" title="No configuration changes yet" /> : (
          <div class="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
              <tbody>
                {audit.map((a: any) => (
                  <tr>
                    <td class="small nowrap muted">{relTime(a.created_at)}</td>
                    <td class="small">{a.actor_name || 'system'}</td>
                    <td class="small"><b>{a.action}</b></td>
                    <td class="small mono muted">{a.target}</td>
                    <td class="small mono" style="max-width:420px;overflow:hidden;text-overflow:ellipsis">
                      {a.detail && a.detail !== '{}' ? a.detail.slice(0, 160) : '—'}
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

/* ================================================================= security */
export const AiSecurityPage = ({ user, data }: { user: AuthUser; data: any }) => {
  const { settings, providers, days } = data
  const editable = can(user.role, 'ai.configure')
  const risk = settings.pii_policy === 'allow'

  return (
    <Layout user={user} active="/ai" title="AI security">
      <PageHead
        title="AI security & privacy"
        sub="These controls are enforced inside the gateway, not in the browser. They apply to every feature and every provider."
      />
      <AiTabs active="/ai/security" />

      {risk ? (
        <div class="danger-note mb16">
          <b>PII policy is set to “allow”.</b> Candidate emails and phone numbers will be sent to external
          providers verbatim. Switch to “redact” unless you have an explicit data-processing agreement.
        </div>
      ) : null}

      <div class="split mb16">
        <Card title="Privacy controls">
          {editable ? (
            <form data-api="/api/ai/settings" data-method="post" data-reload="1" class="stack">
              <Field label="PII policy for external providers"
                help="redact replaces emails/phones with placeholders · block refuses the call · allow passes through (not recommended)">
                <select name="pii_policy">
                  {['redact', 'block', 'allow'].map((v) => (
                    <option value={v} selected={settings.pii_policy === v}>{v}</option>
                  ))}
                </select>
              </Field>
              <Field label="External AI calls" help="When disabled, only local providers (Ollama) may be used">
                <select name="external_calls_enabled">
                  <option value="1" selected={settings.external_calls_enabled !== '0'}>Allowed</option>
                  <option value="0" selected={settings.external_calls_enabled === '0'}>Disabled — local only</option>
                </select>
              </Field>
              <div class="grid g2">
                <Field label="Retries per provider" help="Exponential backoff on 429/5xx">
                  <input name="max_retries" type="number" min="0" max="5" value={settings.max_retries} />
                </Field>
                <Field label="Request log retention" help="days">
                  <input name="request_log_retention_days" type="number" min="1" max="365" value={settings.request_log_retention_days} />
                </Field>
              </div>
              <div class="row"><button class="btn primary" type="submit"><i class="fa-solid fa-floppy-disk"></i> Save security settings</button></div>
            </form>
          ) : (
            <div class="stack">
              <div class="row" style="justify-content:space-between"><span class="small muted">PII policy</span><Badge tone={risk ? 'danger' : 'ok'}>{settings.pii_policy}</Badge></div>
              <div class="row" style="justify-content:space-between"><span class="small muted">External calls</span><span class="small">{settings.external_calls_enabled === '0' ? 'disabled' : 'allowed'}</span></div>
              <div class="row" style="justify-content:space-between"><span class="small muted">Retries</span><span class="small">{settings.max_retries}</span></div>
              <div class="row" style="justify-content:space-between"><span class="small muted">Retention</span><span class="small">{settings.request_log_retention_days} days</span></div>
            </div>
          )}
        </Card>

        <Card title="Credential storage">
          <div class="stack">
            <div class="row" style="justify-content:space-between">
              <span class="small muted">Encryption</span><span class="small"><b>AES-GCM 256</b></span>
            </div>
            <div class="row" style="justify-content:space-between">
              <span class="small muted">Key derivation</span><span class="small">PBKDF2 · 100k</span>
            </div>
            <div class="row" style="justify-content:space-between">
              <span class="small muted">At rest</span><span class="small">D1, ciphertext + IV</span>
            </div>
            <p class="tiny muted" style="margin:6px 0 0">
              API keys are decrypted in Worker memory per request. They are never written to logs,
              never returned by an API, and never rendered into a page. Only the last four characters
              are shown for identification.
            </p>
          </div>
        </Card>
      </div>

      <Card title="Provider exposure" sub="Which providers can receive candidate data" tight>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Provider</th><th>Type</th><th>Enabled</th><th>Credential</th><th>Last error</th></tr></thead>
            <tbody>
              {providers.map((p: any) => (
                <tr>
                  <td class="small"><b>{p.name}</b></td>
                  <td class="small">{p.local_only ? <Badge tone="info">local</Badge> : <Badge tone="warn">external</Badge>}</td>
                  <td class="small">{p.enabled ? 'yes' : 'no'}</td>
                  <td class="small muted">{p.has_key ? p.api_key_hint : (p.local_only ? 'n/a' : '—')}</td>
                  <td class="small muted">{p.last_error ? p.last_error.slice(0, 60) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div class="mb16" />
      <Card title="Data handling commitments">
        <ul class="small" style="margin:0;padding-left:18px;line-height:1.9">
          <li>Resume text and AI output are treated as <b>untrusted input</b>; nothing is executed or rendered as HTML.</li>
          <li>AI output is <b>advisory only</b> — no automated rejection, hiring or advancement decisions.</li>
          <li>Candidate personal data is only sent externally when the <b>PII policy</b> permits it.</li>
          <li>Local Ollama inference never leaves the deployment and incurs <b>no API cost</b>.</li>
          <li>Prompts and completions are not persisted in the request log — only metadata, tokens and latency.</li>
          <li>Log retention is enforced at <b>{days}</b> days by the purge job.</li>
        </ul>
      </Card>
    </Layout>
  )
}

/* ================================================= ATS AI feature panel (ui) */
/**
 * Shared panel used on candidate / job screens to invoke a feature and show the
 * advisory result. Rendered server-side; the JSON comes back from /api/ai/run/*.
 */
export const AiAdvisoryNote = () => (
  <p class="tiny muted" style="margin:8px 0 0">
    <i class="fa-solid fa-circle-info" /> AI output is advisory. It never rejects, hires,
    or makes a final employment decision — a human reviewer decides.
  </p>
)
