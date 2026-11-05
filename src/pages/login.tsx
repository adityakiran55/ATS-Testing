import { LoginLayout } from '../components/layout'

const DEMO = [
  { email: 'admin@vsolutions.dev', name: 'Dana Whitfield', role: 'Administrator', icon: 'fa-user-shield' },
  { email: 'recruiter@vsolutions.dev', name: 'Marco Reyes', role: 'Recruiter', icon: 'fa-user-tie' },
  { email: 'manager@vsolutions.dev', name: 'Priya Raman', role: 'Hiring Manager', icon: 'fa-user-check' },
  { email: 'interviewer@vsolutions.dev', name: 'Jonas Berg', role: 'Interviewer', icon: 'fa-clipboard-user' },
  { email: 'coordinator@vsolutions.dev', name: 'Amelia Fox', role: 'Coordinator', icon: 'fa-calendar-check' }
]

export const LoginPage = ({ next, error }: { next?: string; error?: string }) => (
  <LoginLayout>
    <div class="login-wrap">
      <div class="login-art">
        <div class="row" style="gap:10px">
          <span class="brand-mark" style="width:34px;height:34px">VS</span>
          <b style="color:#fff;font-size:15px">VSolutions ATS</b>
        </div>
        <div>
          <h1>Recruiting operations, end to end.</h1>
          <p>
            Requisition intake through offer and onboarding handoff — with Boolean and semantic
            talent rediscovery, duplicate-safe candidate identity, SLA enforcement, and
            evidence-backed AI assistance that never decides for you.
          </p>
          <div class="row wrap" style="gap:6px;margin-top:18px">
            {['ATS-01 Search', 'ATS-02 Merge', 'ATS-03 Distribution', 'ATS-04 Comms', 'ATS-05 Automation',
              'ATS-07 SLA', 'ATS-09 Analytics', 'ATS-12 AI compare'].map((t) => (
              <span class="badge" style="background:rgba(255,255,255,.1);color:#c7d2fe">{t}</span>
            ))}
          </div>
        </div>
        <p style="font-size:12px;color:#64748b">Version 2.0 · ATS-only scope · 05 Nov 2026</p>
      </div>

      <div class="login-form">
        <h2>Sign in</h2>
        <p class="muted small" style="margin-bottom:18px">Use a demo account below, or your credentials.</p>

        {error ? <div class="danger-note" style="margin-bottom:14px">{error}</div> : null}

        <form data-api="/api/auth/login" data-method="post" data-redirect={next || '/'}>
          <input type="hidden" name="next" value={next || '/'} />
          <div class="stack">
            <div>
              <label class="field">Email</label>
              <input type="email" name="email" id="login-email" required placeholder="you@company.com" autocomplete="username" />
            </div>
            <div>
              <label class="field">Password</label>
              <input type="password" name="password" id="login-password" required value="Password123!" autocomplete="current-password" />
            </div>
            <button class="btn primary" type="submit" style="justify-content:center">
              <i class="fa-solid fa-arrow-right-to-bracket"></i> Sign in
            </button>
          </div>
        </form>

        <div style="margin-top:22px">
          <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:7px">
            Demo accounts · password <span class="kbd">Password123!</span>
          </div>
          <div class="demo-users">
            {DEMO.map((d) => (
              <button class="demo-user" type="button" onclick={`document.getElementById('login-email').value='${d.email}'`}>
                <i class={`fa-solid ${d.icon}`} style="color:var(--brand);width:14px"></i>
                <span style="flex:1">
                  <b>{d.name}</b>
                  <span> · {d.role}</span>
                  <span class="mono" style="display:block;font-size:10.5px;color:var(--ink-3)">{d.email}</span>
                </span>
                <i class="fa-solid fa-chevron-right" style="font-size:9px;opacity:.4"></i>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
    <script src="/static/app.js"></script>
  </LoginLayout>
)
