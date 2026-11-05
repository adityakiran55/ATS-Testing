import type { Permission } from './rbac'

/** ---------------------------------------------------------------- requisition */
export const JOB_STATUSES = [
  'draft', 'submitted', 'pending_approval', 'approved', 'open', 'paused', 'filled', 'cancelled', 'closed'
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const JOB_TRANSITIONS: Record<string, { to: string[]; perm: Permission; label: string; requiresReason?: boolean }[]> = {
  draft: [
    { to: 'submitted', perm: 'job.submit', label: 'Submit for approval' },
    { to: 'cancelled', perm: 'job.close', label: 'Cancel', requiresReason: true }
  ],
  submitted: [
    { to: 'pending_approval', perm: 'job.submit', label: 'Send to approver' },
    { to: 'draft', perm: 'job.edit', label: 'Return to draft', requiresReason: true }
  ],
  pending_approval: [
    { to: 'approved', perm: 'job.approve', label: 'Approve' },
    { to: 'draft', perm: 'job.approve', label: 'Reject / request changes', requiresReason: true }
  ],
  approved: [
    { to: 'open', perm: 'job.edit', label: 'Open requisition' },
    { to: 'cancelled', perm: 'job.close', label: 'Cancel', requiresReason: true }
  ],
  open: [
    { to: 'paused', perm: 'job.edit', label: 'Pause', requiresReason: true },
    { to: 'filled', perm: 'job.close', label: 'Mark filled' },
    { to: 'closed', perm: 'job.close', label: 'Close', requiresReason: true },
    { to: 'cancelled', perm: 'job.close', label: 'Cancel', requiresReason: true }
  ],
  paused: [
    { to: 'open', perm: 'job.edit', label: 'Re-open' },
    { to: 'closed', perm: 'job.close', label: 'Close', requiresReason: true },
    { to: 'cancelled', perm: 'job.close', label: 'Cancel', requiresReason: true }
  ],
  filled: [{ to: 'closed', perm: 'job.close', label: 'Close' }],
  cancelled: [],
  closed: []
}

/** ---------------------------------------------------------------- application */
export const STAGE_ORDER = [
  'applied', 'parsing', 'screening', 'recruiter_review', 'manager_review', 'interview', 'offer', 'hired'
] as const
export type Stage = (typeof STAGE_ORDER)[number]

export const TERMINAL_APP_STATUSES = ['rejected', 'withdrawn', 'hired'] as const

export const stageIndex = (s: string): number => STAGE_ORDER.indexOf(s as Stage)

export const APP_PERMISSION_FOR_STAGE: Record<string, Permission> = {
  applied: 'application.create',
  parsing: 'application.move',
  screening: 'application.move',
  recruiter_review: 'application.move',
  manager_review: 'application.move',
  interview: 'application.move',
  offer: 'application.move',
  hired: 'application.move'
}

/**
 * Stage moves: one step forward, any forward jump with an explicit reason,
 * one step back with an explicit reason. Terminal statuses are separate.
 */
export const validateStageMove = (
  from: string,
  to: string
): { ok: boolean; code?: string; message?: string; requiresReason?: boolean } => {
  if (!STAGE_ORDER.includes(to as Stage)) return { ok: false, code: 'unknown_stage', message: `Unknown stage "${to}"` }
  if (from === to) return { ok: false, code: 'noop', message: 'Application is already in this stage' }
  const fi = stageIndex(from)
  const ti = stageIndex(to)
  if (ti === fi + 1) return { ok: true }
  if (ti > fi + 1) return { ok: true, requiresReason: true }
  if (ti === fi - 1) return { ok: true, requiresReason: true }
  return { ok: false, code: 'backward_jump', message: 'Multi-stage rewind requires a new application' }
}

/** ---------------------------------------------------------------- interview */
export const INTERVIEW_TRANSITIONS: Record<string, string[]> = {
  draft: ['scheduled', 'cancelled'],
  scheduled: ['confirmed', 'cancelled', 'scheduled'],
  confirmed: ['completed', 'cancelled', 'scheduled'],
  completed: ['feedback_pending', 'decision'],
  feedback_pending: ['feedback_complete', 'completed'],
  feedback_complete: ['decision'],
  decision: [],
  cancelled: []
}

/** ---------------------------------------------------------------- offer */
export const OFFER_TRANSITIONS: Record<string, { to: string[]; perm: Permission; label: string }[]> = {
  draft: [
    { to: 'approval_pending', perm: 'offer.create', label: 'Send for approval' },
    { to: 'withdrawn', perm: 'offer.release', label: 'Withdraw' }
  ],
  approval_pending: [
    { to: 'approved', perm: 'offer.approve', label: 'Approve offer' },
    { to: 'draft', perm: 'offer.approve', label: 'Return to draft' }
  ],
  approved: [
    { to: 'released', perm: 'offer.release', label: 'Release to candidate' },
    { to: 'withdrawn', perm: 'offer.release', label: 'Withdraw' }
  ],
  released: [
    { to: 'accepted', perm: 'offer.respond', label: 'Mark accepted' },
    { to: 'declined', perm: 'offer.respond', label: 'Mark declined' },
    { to: 'expired', perm: 'offer.respond', label: 'Mark expired' },
    { to: 'withdrawn', perm: 'offer.release', label: 'Withdraw' }
  ],
  accepted: [],
  declined: [],
  expired: [],
  withdrawn: []
}

/** ---------------------------------------------------------------- onboarding */
export const ONBOARDING_TRANSITIONS: Record<string, string[]> = {
  not_started: ['initiated', 'cancelled'],
  initiated: ['pending_documents', 'ready_to_join', 'cancelled', 'no_show'],
  pending_documents: ['ready_to_join', 'cancelled', 'no_show'],
  ready_to_join: ['joined', 'no_show', 'cancelled'],
  joined: [],
  no_show: [],
  cancelled: []
}

/** ---------------------------------------------------------------- resume */
export const RESUME_TRANSITIONS: Record<string, string[]> = {
  uploaded: ['malware_scan', 'failed'],
  malware_scan: ['queued', 'failed'],
  queued: ['parsing', 'failed'],
  parsing: ['parsed', 'failed', 'queued'],
  parsed: ['screening_ready', 'failed'],
  screening_ready: [],
  failed: ['queued', 'dead_letter'],
  dead_letter: ['queued']
}

/** ---------------------------------------------------------------- posting */
export const POSTING_TRANSITIONS: Record<string, string[]> = {
  draft: ['queued', 'withdrawn'],
  queued: ['published', 'failed'],
  published: ['expired', 'withdrawn', 'failed'],
  failed: ['queued', 'withdrawn'],
  expired: ['queued', 'withdrawn'],
  withdrawn: ['queued']
}

/** Generic guard used by all state-changing handlers. */
export const assertTransition = (
  table: Record<string, string[]>,
  from: string,
  to: string
): { ok: boolean; message?: string } => {
  const allowed = table[from] || []
  if (!allowed.includes(to)) {
    return { ok: false, message: `Illegal transition ${from} → ${to}. Allowed: ${allowed.join(', ') || 'none'}` }
  }
  return { ok: true }
}
