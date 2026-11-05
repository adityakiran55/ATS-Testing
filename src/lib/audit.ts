import { nowIso, hashString, parseJson } from './util'

export type AuditInput = {
  entityType: string
  entityId: string | number
  action: string
  actorId?: number | null
  previousValue?: unknown
  newValue?: unknown
  reason?: string | null
  meta?: Record<string, unknown>
}

/** Append-only audit trail: actor, timestamp, previous value, new value, reason. */
export const audit = async (
  db: D1Database,
  input: AuditInput
): Promise<void> => {
  const serialize = (v: unknown) =>
    v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v)
  await db
    .prepare(
      `INSERT INTO audit_events
        (entity_type, entity_id, action, actor_id, previous_value, new_value, reason, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.entityType,
      String(input.entityId),
      input.action,
      input.actorId ?? null,
      serialize(input.previousValue),
      serialize(input.newValue),
      input.reason ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
      nowIso()
    )
    .run()
}

export const auditList = async (
  db: D1Database,
  filters: { entityType?: string; entityId?: string; actorId?: number; limit?: number; offset?: number } = {}
) => {
  const where: string[] = []
  const args: unknown[] = []
  if (filters.entityType) { where.push('entity_type = ?'); args.push(filters.entityType) }
  if (filters.entityId) { where.push('entity_id = ?'); args.push(filters.entityId) }
  if (filters.actorId) { where.push('actor_id = ?'); args.push(filters.actorId) }
  const sql = `SELECT a.*, u.name AS actor_name, u.role AS actor_role
                 FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY a.id DESC
                LIMIT ? OFFSET ?`
  const { results } = await db.prepare(sql).bind(...args, filters.limit ?? 50, filters.offset ?? 0).all<any>()
  return results.map((r) => ({
    ...r,
    previous_value: parseJson(r.previous_value, null),
    new_value: parseJson(r.new_value, null),
    meta: parseJson(r.meta, null)
  }))
}

/**
 * Event bus. Every domain event is written to automation_event_queue with a
 * deterministic key so retries are idempotent, then matching rules execute
 * inline (edge has no background workers) and record a run row.
 */
export const emitEvent = async (
  db: D1Database,
  eventName: string,
  payload: Record<string, unknown>,
  options: { eventKey?: string; actorId?: number | null } = {}
): Promise<{ queued: number; runs: any[] }> => {
  const canonical = JSON.stringify(
    Object.keys(payload).sort().reduce((acc: Record<string, unknown>, k) => {
      acc[k] = payload[k]
      return acc
    }, {})
  )
  const eventKey = options.eventKey || `${eventName}:${hashString(eventName + canonical)}`

  await db
    .prepare(
      `INSERT INTO automation_event_queue (event_name, event_key, payload, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT(event_key) DO NOTHING`
    )
    .bind(eventName, eventKey, canonical, nowIso())
    .run()

  const { results: rules } = await db
    .prepare('SELECT * FROM automation_rules WHERE enabled = 1 AND trigger_event = ?')
    .bind(eventName)
    .all<any>()

  const runs: any[] = []
  for (const rule of rules) {
    runs.push(await executeRule(db, rule, { eventName, eventKey, payload, actorId: options.actorId }))
  }

  await db
    .prepare("UPDATE automation_event_queue SET status = 'processed', attempts = attempts + 1 WHERE event_key = ?")
    .bind(eventKey)
    .run()

  return { queued: eventKey ? 1 : 0, runs }
}

const matchesConditions = (conditions: any[], payload: any): { ok: boolean; failed?: string } => {
  for (const cond of conditions || []) {
    const value = payload[cond.field]
    switch (cond.op) {
      case 'eq': if (String(value) !== String(cond.value)) return { ok: false, failed: cond.field }; break
      case 'neq': if (String(value) === String(cond.value)) return { ok: false, failed: cond.field }; break
      case 'in': if (!(cond.value || []).map(String).includes(String(value))) return { ok: false, failed: cond.field }; break
      case 'not_in': if ((cond.value || []).map(String).includes(String(value))) return { ok: false, failed: cond.field }; break
      case 'gt': if (!(Number(value) > Number(cond.value))) return { ok: false, failed: cond.field }; break
      case 'lt': if (!(Number(value) < Number(cond.value))) return { ok: false, failed: cond.field }; break
      case 'exists': if (value === undefined || value === null || value === '') return { ok: false, failed: cond.field }; break
      default: break
    }
  }
  return { ok: true }
}

const runAction = async (db: D1Database, action: any, payload: any, testMode: boolean): Promise<string> => {
  const appId = payload.application_id ? Number(payload.application_id) : null
  const jobId = payload.job_id ? Number(payload.job_id) : null
  const candId = payload.candidate_id ? Number(payload.candidate_id) : null
  if (testMode) return `test:${action.type}`

  switch (action.type) {
    case 'create_task': {
      await db
        .prepare(
          `INSERT INTO tasks (type, title, detail, application_id, job_id, assignee_id, due_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          action.type_ || 'custom',
          action.title || 'Automated task',
          action.detail || null,
          appId,
          jobId,
          action.assignee_id || payload.assignee_id || null,
          action.due_in_hours ? new Date(Date.now() + action.due_in_hours * 3600_000).toISOString() : null,
          null
        )
        .run()
      return 'task_created'
    }
    case 'send_message': {
      if (!candId) return 'skipped:no_candidate'
      const cand = await db.prepare('SELECT email, first_name, consent_status FROM candidates WHERE id = ?').bind(candId).first<any>()
      if (!cand) return 'skipped:candidate_missing'
      if (cand.consent_status === 'opt_out') return 'skipped:opted_out'
      const tpl = action.template_id
        ? await db.prepare('SELECT * FROM message_templates WHERE id = ?').bind(action.template_id).first<any>()
        : null
      const subject = tpl?.subject || action.subject || 'Update on your application'
      const body = (tpl?.body || action.body || 'Hello {{first_name}},')
        .replace(/\{\{first_name\}\}/g, cand.first_name)
        .replace(/\{\{job_title\}\}/g, payload.job_title || 'the role')
      await db
        .prepare(
          `INSERT INTO messages (candidate_id, application_id, template_id, channel, to_address, subject, body, status, provider, sent_at)
           VALUES (?, ?, ?, 'email', ?, ?, ?, 'sent', ?, ?)`
        )
        .bind(candId, appId, action.template_id || null, cand.email, subject, body, 'internal-sim', nowIso())
        .run()
      return 'message_sent'
    }
    case 'notify_user': {
      await db
        .prepare(
          `INSERT INTO tasks (type, title, detail, application_id, job_id, assignee_id, due_at, created_by)
           VALUES ('sla_alert', ?, ?, ?, ?, ?, ?, NULL)`
        )
        .bind(
          action.title || 'Automation notification',
          action.detail || null,
          appId,
          jobId,
          action.user_id || payload.owner_id || null,
          nowIso()
        )
        .run()
      return 'notified'
    }
    case 'set_stage': {
      if (!appId) return 'skipped:no_application'
      await db.prepare("UPDATE applications SET updated_at = ? WHERE id = ?").bind(nowIso(), appId).run()
      return 'stage_noted'
    }
    case 'log_only':
      return 'logged'
    default:
      return `unsupported:${action.type}`
  }
}

const executeRule = async (
  db: D1Database,
  rule: any,
  ctx: { eventName: string; eventKey: string; payload: any; actorId?: number | null }
) => {
  const conditions = parseJson<any[]>(rule.conditions, [])
  const actions = parseJson<any[]>(rule.actions, [])
  const cond = matchesConditions(conditions, ctx.payload)

  let status = 'success'
  const details: string[] = []

  try {
    if (!cond.ok) {
      status = 'skipped'
      details.push(`condition_failed:${cond.failed}`)
    } else {
      for (const action of actions) {
        details.push(await runAction(db, action, ctx.payload, !!rule.test_mode))
      }
      if (rule.test_mode) status = 'test'
    }
  } catch (err: any) {
    status = 'failed'
    details.push(`error:${err?.message || 'unknown'}`)
  }

  const existing = await db
    .prepare('SELECT id, attempts FROM automation_runs WHERE rule_id = ? AND event_key = ?')
    .bind(rule.id, ctx.eventKey)
    .first<any>()

  if (existing) {
    await db
      .prepare('UPDATE automation_runs SET status = ?, detail = ?, attempts = ? WHERE id = ?')
      .bind(status, details.join('; '), existing.attempts + 1, existing.id)
      .run()
  } else {
    await db
      .prepare(
        `INSERT INTO automation_runs (rule_id, event_key, event_name, entity_ref, status, detail, attempts)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .bind(rule.id, ctx.eventKey, ctx.eventName, ctx.payload.application_id ? `application:${ctx.payload.application_id}` : null, status, details.join('; '))
      .run()
  }

  await db
    .prepare(
      `UPDATE automation_rules SET last_run_at = ?, run_count = run_count + 1,
              fail_count = fail_count + ? WHERE id = ?`
    )
    .bind(nowIso(), status === 'failed' ? 1 : 0, rule.id)
    .run()

  return { rule_id: rule.id, rule: rule.name, status, detail: details.join('; ') }
}
