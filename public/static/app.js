/* VSolutions ATS — client runtime: toasts, API helper, and declarative actions. */
(() => {
  const host = () => document.getElementById('toast-host')

  window.toast = (msg, kind = '') => {
    const el = document.createElement('div')
    el.className = 'toast ' + kind
    el.textContent = msg
    host().appendChild(el)
    setTimeout(() => el.remove(), 4200)
  }

  window.api = async (path, options = {}) => {
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin'
    })
    let data = null
    const text = await res.text()
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || `Request failed (${res.status})`
      const err = new Error(msg)
      err.status = res.status
      err.data = data
      throw err
    }
    return data
  }

  /* Generic submit handler: <form data-api="/api/x" data-method="post" data-reload="1"> */
  document.addEventListener('submit', async (e) => {
    const form = e.target
    if (!(form instanceof HTMLFormElement)) return
    const endpoint = form.dataset.api
    if (!endpoint) return
    e.preventDefault()
    const btn = form.querySelector('button[type=submit], button:not([type])')
    const prev = btn ? btn.innerHTML : ''
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>' }
    const payload = {}
    new FormData(form).forEach((v, k) => {
      if (payload[k] === undefined) payload[k] = v
      else if (Array.isArray(payload[k])) payload[k].push(v)
      else payload[k] = [payload[k], v]
    })
    form.querySelectorAll('input[type=checkbox][name]').forEach((c) => {
      payload[c.name] = payload[c.name] !== undefined ? payload[c.name] : (c.checked ? 'true' : 'false')
      if (Array.isArray(payload[c.name])) payload[c.name] = c.checked ? payload[c.name] : []
      if (typeof payload[c.name] === 'string') payload[c.name] = c.checked ? 'true' : 'false'
    })
    try {
      const out = await api(endpoint, { method: (form.dataset.method || 'post').toUpperCase(), body: payload })
      if (form.dataset.toast) toast(form.dataset.toast, 'ok')
      else toast(out?.message || 'Saved', 'ok')
      if (form.dataset.reload === '1') setTimeout(() => location.reload(), 450)
      else if (form.dataset.redirect) setTimeout(() => { location.href = form.dataset.redirect.replace('{id}', out?.id ?? '') }, 350)
      else if (form.dataset.onDone) window[form.dataset.onDone]?.(out)
      form.dispatchEvent(new CustomEvent('api:done', { detail: out, bubbles: true }))
    } catch (err) {
      toast(err.message, 'err')
      form.dispatchEvent(new CustomEvent('api:error', { detail: err, bubbles: true }))
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = prev }
    }
  })

  /* Declarative click actions: <button data-act="/api/x" data-body='{"a":1}' data-reload="1"> */
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]')
    if (!el) return
    e.preventDefault()
    const method = el.dataset.method || 'POST'
    let body = {}
    if (el.dataset.body) { try { body = JSON.parse(el.dataset.body) } catch { body = {} } }
    if (el.dataset.prompt) {
      const v = window.prompt(el.dataset.prompt)
      if (v === null) return
      body.reason = v
    }
    if (el.dataset.confirm && !window.confirm(el.dataset.confirm)) return
    el.disabled = true
    try {
      const out = await api(el.dataset.act, { method, body })
      toast(out?.message || 'Done', 'ok')
      if (el.dataset.reload === '1') setTimeout(() => location.reload(), 400)
      else if (el.dataset.redirect) setTimeout(() => { location.href = el.dataset.redirect.replace('{id}', out?.id ?? '') }, 300)
      else if (el.dataset.onDone) window[el.dataset.onDone]?.(out)
      el.dispatchEvent(new CustomEvent('api:done', { detail: out, bubbles: true }))
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      el.disabled = false
    }
  })

  /* Modal helpers */
  window.openModal = (id) => { const d = document.getElementById(id); if (d && d.showModal) d.showModal() }
  window.closeModal = (id) => { const d = document.getElementById(id); if (d && d.close) d.close() }

  /* Busy indicators on navigation */
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]')
    if (!a || a.target === '_blank' || a.getAttribute('href').startsWith('#')) return
    document.body.style.cursor = 'progress'
  })
})()
