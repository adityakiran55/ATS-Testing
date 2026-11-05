import type { Child } from 'hono/jsx'
import { initials, titleCase, fmtDate, relTime, money, truncate } from '../lib/util'

/* ------------------------------------------------------------------ layout */
export const PageHead = ({ title, sub, actions }: { title: string; sub?: string; actions?: Child }) => (
  <div class="page-head">
    <div class="grow">
      <h1>{title}</h1>
      {sub ? <p>{sub}</p> : null}
    </div>
    {actions ? <div class="page-actions">{actions}</div> : null}
  </div>
)

export const Card = ({ title, sub, actions, children, tight }: {
  title?: string; sub?: string; actions?: Child; children: Child; tight?: boolean
}) => (
  <section class="card">
    {title ? (
      <header>
        <h3>{title}</h3>
        {sub ? <span class="sub">{sub}</span> : null}
        {actions}
      </header>
    ) : null}
    <div class={tight ? 'card-body tight' : 'card-body'}>{children}</div>
  </section>
)

export const Stat = ({ label, value, meta, tone }: { label: string; value: Child; meta?: Child; tone?: string }) => (
  <div class="card stat">
    <div class="label">{label}</div>
    <div class="value" style={tone ? `color:${tone}` : ''}>{value}</div>
    {meta ? <div class="meta">{meta}</div> : null}
  </div>
)

/* ------------------------------------------------------------------ badges */
const JOB_TONE: Record<string, string> = {
  draft: 'slate', submitted: 'info', pending_approval: 'warn', approved: 'brand',
  open: 'ok', paused: 'warn', filled: 'violet', cancelled: 'danger', closed: 'slate'
}
const APP_TONE: Record<string, string> = {
  active: 'info', on_hold: 'warn', rejected: 'danger', withdrawn: 'slate', hired: 'ok'
}
const OFFER_TONE: Record<string, string> = {
  draft: 'slate', approval_pending: 'warn', approved: 'brand', released: 'info',
  accepted: 'ok', declined: 'danger', expired: 'slate', withdrawn: 'slate'
}
const POSTING_TONE: Record<string, string> = {
  draft: 'slate', queued: 'warn', published: 'ok', failed: 'danger', expired: 'slate', withdrawn: 'slate'
}
const MSG_TONE: Record<string, string> = { queued: 'warn', sent: 'ok', failed: 'danger', bounced: 'danger', skipped: 'slate' }
const RESUME_TONE: Record<string, string> = {
  uploaded: 'slate', malware_scan: 'info', queued: 'warn', parsing: 'warn',
  parsed: 'brand', screening_ready: 'ok', failed: 'danger', dead_letter: 'danger'
}

export const Badge = ({ children, tone = 'slate', dot }: { children: Child; tone?: string; dot?: boolean }) => (
  <span class={`badge ${tone}${dot ? ' dot' : ''}`}>{children}</span>
)

export const JobStatus = ({ status }: { status: string }) => (
  <Badge tone={JOB_TONE[status] || 'slate'} dot>{titleCase(status)}</Badge>
)
export const AppStatus = ({ status }: { status: string }) => (
  <Badge tone={APP_TONE[status] || 'slate'} dot>{titleCase(status)}</Badge>
)
export const OfferStatus = ({ status }: { status: string }) => (
  <Badge tone={OFFER_TONE[status] || 'slate'} dot>{titleCase(status)}</Badge>
)
export const PostingStatus = ({ status }: { status: string }) => (
  <Badge tone={POSTING_TONE[status] || 'slate'} dot>{titleCase(status)}</Badge>
)
export const MsgStatus = ({ status }: { status: string }) => (
  <Badge tone={MSG_TONE[status] || 'slate'} dot>{titleCase(status)}</Badge>
)
export const ResumeStatus = ({ status }: { status: string }) => (
  <Badge tone={RESUME_TONE[status] || 'slate'} dot>{titleCase(status)}</Badge>
)
export const StageBadge = ({ stage }: { stage: string }) => <Badge tone="brand">{titleCase(stage)}</Badge>

/* ------------------------------------------------------------------ inputs */
export const Field = ({ label, children, help, full }: { label: string; children: Child; help?: string; full?: boolean }) => (
  <div class={full ? 'full' : ''}>
    <label class="field">{label}</label>
    {children}
    {help ? <div class="help">{help}</div> : null}
  </div>
)

export const Select = ({ name, options, value, placeholder }: {
  name: string; options: { value: string; label: string }[]; value?: string | number | null; placeholder?: string
}) => (
  <select name={name}>
    {placeholder ? <option value="">{placeholder}</option> : null}
    {options.map((o) => (
      <option value={o.value} selected={String(value ?? '') === String(o.value)}>{o.label}</option>
    ))}
  </select>
)

export const Empty = ({ icon = 'fa-inbox', title, sub }: { icon?: string; title: string; sub?: string }) => (
  <div class="empty">
    <i class={`fa-solid ${icon}`}></i>
    <b>{title}</b>
    {sub ? <div class="small">{sub}</div> : null}
  </div>
)

export const Avatar = ({ first, last, size }: { first: string; last: string; size?: number }) => (
  <span class="avatar" style={size ? `width:${size}px;height:${size}px;font-size:${Math.round(size / 2.8)}px` : ''}>
    {initials(first, last)}
  </span>
)

export const Person = ({ first, last, sub, small }: { first: string; last: string; sub?: string; small?: boolean }) => (
  <div class="row" style="gap:9px">
    <Avatar first={first} last={last} size={small ? 28 : 34} />
    <div style="min-width:0">
      <div class="cell-main" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{first} {last}</div>
      {sub ? <div class="cell-sub">{sub}</div> : null}
    </div>
  </div>
)

export const Meta = ({ items }: { items: [string, Child][] }) => (
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">
    {items.map(([k, v]) => (
      <div>
        <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.05em;font-weight:700">{k}</div>
        <div style="margin-top:2px;font-weight:600">{v}</div>
      </div>
    ))}
  </div>
)

/** Horizontal bar list used by source/stage breakdowns. */
export const Bars = ({ rows, unit }: { rows: { label: string; value: number; sub?: string }[]; unit?: string }) => {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div class="bars">
      {rows.map((r) => (
        <div class="b-row">
          <div class="lab" title={r.label}>{r.label}</div>
          <div class="bar"><span style={`width:${Math.round((r.value / max) * 100)}%`}></span></div>
          <div class="val">{r.value}{unit || ''}</div>
        </div>
      ))}
    </div>
  )
}

export const FunnelChart = ({ funnel }: { funnel: { stage: string; count: number; conversion_from_previous: number }[] }) => {
  const max = Math.max(1, ...funnel.map((f) => f.count))
  return (
    <div class="funnel">
      {funnel.map((f) => (
        <div class="funnel-row">
          <div class="stage">{titleCase(f.stage === 'recruiter_review' ? 'Recruiter review' : f.stage === 'manager_review' ? 'Manager review' : f.stage)}</div>
          <div class="track"><span style={`width:${Math.max(7, Math.round((f.count / max) * 100))}%`}>{f.count}</span></div>
          <div class="conv">{f.conversion_from_previous}%</div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ misc */
export const AgingPill = ({ hours, threshold }: { hours: number; threshold: number }) => {
  const over = hours > threshold
  const pctUsed = Math.min(100, Math.round((hours / threshold) * 100))
  const tone = over ? 'danger' : pctUsed > 75 ? 'warn' : 'ok'
  return (
    <div style="min-width:96px">
      <div class="row between tiny" style="margin-bottom:3px">
        <span class={over ? 'badge danger' : ''} style={over ? '' : 'color:var(--ink-3)'}>
          {hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`}
        </span>
        {over ? <i class="fa-solid fa-triangle-exclamation" style="color:var(--danger);font-size:10px"></i> : null}
      </div>
      <div class={`bar ${tone}`}><span style={`width:${pctUsed}%`}></span></div>
    </div>
  )
}

export const SourceTag = ({ source }: { source?: string | null }) => (
  <span class="badge slate">{source || 'Unknown'}</span>
)

export const Timeline = ({ items }: {
  items: { title: string; meta?: string; body?: Child; tone?: string }[]
}) => (
  <div class="timeline">
    {items.map((i) => (
      <div class={`tl-item ${i.tone || ''}`}>
        <div class="tl-head"><b>{i.title}</b>{i.meta ? <span class="tl-meta">{i.meta}</span> : null}</div>
        {i.body ? <div class="tl-body">{i.body}</div> : null}
      </div>
    ))}
  </div>
)

export const Confidence = ({ value }: { value: number }) => {
  const pctv = Math.round(value * 100)
  const tone = pctv >= 70 ? 'ok' : pctv >= 45 ? 'warn' : 'danger'
  return (
    <span class="conf">
      <i class="fa-solid fa-gauge-simple" style="font-size:10px"></i>
      confidence <span class={`badge ${tone}`} style="margin-left:2px">{pctv}%</span>
    </span>
  )
}

export const AiBadge = () => (
  <span class="badge violet"><i class="fa-solid fa-wand-magic-sparkles" style="font-size:9px"></i> AI assist</span>
)

export const Metric = ({ label, value, unit, hint }: { label: string; value: string | number; unit?: string; hint?: string }) => (
  <div class="stat">
    <div class="label">{label}</div>
    <div class="value">{value}{unit ? <small>{unit}</small> : null}</div>
    {hint ? <div class="meta">{hint}</div> : null}
  </div>
)

export const moneyOrDash = (n: number | null | undefined, c = 'USD') => money(n, c)
export { fmtDate, relTime, truncate, titleCase }
