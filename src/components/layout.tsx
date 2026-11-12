import type { Child } from 'hono/jsx'
import type { AuthUser } from '../lib/auth'
import { can } from '../lib/rbac'
import { ROLE_LABEL } from '../lib/rbac'
import { initials } from '../lib/util'

type NavItem = { href: string; label: string; icon: string; perm?: string; count?: number; alert?: boolean }

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Overview',
    items: [
      { href: '/', label: 'Dashboard', icon: 'fa-gauge-high' },
      { href: '/analytics', label: 'Analytics', icon: 'fa-chart-column', perm: 'analytics.read' }
    ]
  },
  {
    group: 'Requisitions',
    items: [
      { href: '/jobs', label: 'Requisitions', icon: 'fa-briefcase', perm: 'job.read' },
      { href: '/pipeline', label: 'Pipeline', icon: 'fa-diagram-project', perm: 'application.read' },
      { href: '/board', label: 'Stage board', icon: 'fa-table-columns', perm: 'application.read' },
      { href: '/distribution', label: 'Job distribution', icon: 'fa-bullhorn', perm: 'distribution.read' }
    ]
  },
  {
    group: 'Candidates',
    items: [
      { href: '/candidates', label: 'Talent search', icon: 'fa-magnifying-glass', perm: 'candidate.search' },
      { href: '/taxonomy', label: 'Skill taxonomy', icon: 'fa-sitemap', perm: 'candidate.read' },
      { href: '/candidates/duplicates', label: 'Duplicate review', icon: 'fa-clone', perm: 'candidate.merge', alert: true },
      { href: '/pools', label: 'Talent pools', icon: 'fa-layer-group', perm: 'pool.read' },
      { href: '/communications', label: 'Communications', icon: 'fa-envelope', perm: 'message.read' }
    ]
  },
  {
    group: 'Selection',
    items: [
      { href: '/screening', label: 'Screening queue', icon: 'fa-magnifying-glass-chart', perm: 'application.read' },
      { href: '/interviews', label: 'Interviews', icon: 'fa-calendar-check', perm: 'interview.read' },
      { href: '/manager', label: 'Manager review', icon: 'fa-user-check', perm: 'manager.review' },
      { href: '/offers', label: 'Offers', icon: 'fa-file-signature', perm: 'offer.read' },
      { href: '/onboarding', label: 'Onboarding', icon: 'fa-door-open', perm: 'onboarding.read' }
    ]
  },
  {
    group: 'Operations',
    items: [
      { href: '/sla', label: 'SLA & aging', icon: 'fa-stopwatch', perm: 'sla.read' },
      { href: '/compliance', label: 'Compliance', icon: 'fa-scale-balanced', perm: 'audit.read' },
      { href: '/automation', label: 'Automation', icon: 'fa-bolt', perm: 'automation.read' },
      { href: '/ai', label: 'AI integration', icon: 'fa-robot', perm: 'ai.read' },
      { href: '/settings', label: 'Settings', icon: 'fa-gear', perm: 'admin.settings' },
      { href: '/spec', label: 'Spec & traceability', icon: 'fa-list-check' }
    ]
  }
]

export const Layout = ({ user, active, title, children, query }: {
  user: AuthUser
  active: string
  title: string
  children: Child
  query?: string
}) => {
  const isActive = (href: string) => {
    if (href === '/') return active === '/'
    return active === href || active.startsWith(href + '/')
  }

  return (
    <div class="shell">
      <aside class="sidebar">
        <a href="/" class="brand" style="text-decoration:none">
          <span class="brand-mark">VS</span>
          <span>
            VSolutions ATS
            <small>Recruiting OS</small>
          </span>
        </a>
        <nav class="nav">
          {NAV.map((g) => {
            const items = g.items.filter((i) => !i.perm || can(user.role, i.perm as any))
            if (!items.length) return null
            return (
              <>
                <div class="nav-group">{g.group}</div>
                {items.map((i) => (
                  <a href={i.href} class={isActive(i.href) ? 'active' : ''}>
                    <i class={`fa-solid ${i.icon}`}></i>
                    <span>{i.label}</span>
                  </a>
                ))}
              </>
            )
          })}
        </nav>
      </aside>

      <div class="main">
        <header class="topbar">
          <div class="crumb">
            <i class="fa-solid fa-house" style="font-size:11px;opacity:.5"></i>
            <span>{title}</span>
          </div>
          <div class="spacer"></div>
          <form class="topbar-search" action="/candidates" method="get">
            <i class="fa-solid fa-magnifying-glass" style="font-size:11px"></i>
            <input type="text" name="q" placeholder="Search talent…" value={query || ''} />
          </form>
          <div class="user-chip">
            <span class="avatar">{initials(user.name.split(' ')[0], user.name.split(' ')[1])}</span>
            <div class="who">
              <b>{user.name}</b>
              <span>{ROLE_LABEL[user.role]}</span>
            </div>
            <form action="/api/auth/logout" method="post" style="margin:0">
              <button class="btn ghost sm" type="submit" title="Sign out"><i class="fa-solid fa-arrow-right-from-bracket"></i></button>
            </form>
          </div>
        </header>
        <main class="content">{children}</main>
      </div>
      <div id="toast-host"></div>
    </div>
  )
}

export const LoginLayout = ({ children }: { children: Child }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Sign in · VSolutions ATS</title>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.2/css/all.min.css" rel="stylesheet" />
      <link href="/static/app.css" rel="stylesheet" />
    </head>
    <body>{children}<div id="toast-host"></div></body>
  </html>
)
