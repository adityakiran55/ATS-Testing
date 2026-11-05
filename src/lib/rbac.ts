/**
 * RBAC permission matrix — single source of truth.
 * Feature IDs map to ATS-01..ATS-15 in the specification.
 */
export type Role = 'admin' | 'recruiter' | 'hiring_manager' | 'interviewer' | 'coordinator'

export type Permission =
  | 'job.read' | 'job.create' | 'job.edit' | 'job.submit' | 'job.approve' | 'job.close'
  | 'candidate.read' | 'candidate.create' | 'candidate.edit' | 'candidate.delete' | 'candidate.merge'
  | 'candidate.search' | 'candidate.export' | 'candidate.consent'
  | 'application.read' | 'application.create' | 'application.move' | 'application.reject'
  | 'interview.read' | 'interview.schedule' | 'interview.feedback.submit' | 'interview.feedback.read'
  | 'offer.read' | 'offer.create' | 'offer.approve' | 'offer.release' | 'offer.respond'
  | 'onboarding.read' | 'onboarding.manage'
  | 'distribution.read' | 'distribution.manage'
  | 'message.read' | 'message.send' | 'template.manage'
  | 'automation.read' | 'automation.manage'
  | 'pool.read' | 'pool.manage'
  | 'analytics.read' | 'analytics.export'
  | 'sla.read' | 'sla.manage'
  | 'admin.users' | 'admin.settings' | 'audit.read' | 'spec.read'
  | 'manager.review'

const R = (...p: Permission[]) => p

export const PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    'job.read', 'job.create', 'job.edit', 'job.submit', 'job.approve', 'job.close',
    'candidate.read', 'candidate.create', 'candidate.edit', 'candidate.delete', 'candidate.merge',
    'candidate.search', 'candidate.export', 'candidate.consent',
    'application.read', 'application.create', 'application.move', 'application.reject',
    'interview.read', 'interview.schedule', 'interview.feedback.read',
    'offer.read', 'offer.create', 'offer.approve', 'offer.release', 'offer.respond',
    'onboarding.read', 'onboarding.manage',
    'distribution.read', 'distribution.manage',
    'message.read', 'message.send', 'template.manage',
    'automation.read', 'automation.manage',
    'pool.read', 'pool.manage',
    'analytics.read', 'analytics.export',
    'sla.read', 'sla.manage',
    'admin.users', 'admin.settings', 'audit.read', 'spec.read', 'manager.review'
  ],
  recruiter: [
    'job.read', 'job.create', 'job.edit', 'job.submit', 'job.close',
    'candidate.read', 'candidate.create', 'candidate.edit', 'candidate.merge',
    'candidate.search', 'candidate.export', 'candidate.consent',
    'application.read', 'application.create', 'application.move', 'application.reject',
    'interview.read', 'interview.schedule', 'interview.feedback.read',
    'offer.read', 'offer.create', 'offer.release', 'offer.respond',
    'onboarding.read', 'onboarding.manage',
    'distribution.read', 'distribution.manage',
    'message.read', 'message.send', 'template.manage',
    'automation.read', 'automation.manage',
    'pool.read', 'pool.manage',
    'analytics.read', 'analytics.export',
    'sla.read', 'sla.manage',
    'audit.read', 'spec.read'
  ],
  hiring_manager: [
    'job.read', 'job.create', 'job.edit', 'job.approve',
    'candidate.read', 'candidate.search',
    'application.read', 'application.move', 'application.reject',
    'interview.read', 'interview.schedule', 'interview.feedback.read',
    'offer.read', 'offer.approve',
    'onboarding.read',
    'message.read',
    'pool.read',
    'analytics.read',
    'sla.read',
    'spec.read', 'manager.review'
  ],
  interviewer: [
    'candidate.read', 'application.read',
    'interview.read', 'interview.feedback.submit', 'interview.feedback.read',
    'spec.read'
  ],
  coordinator: [
    'job.read',
    'candidate.read', 'candidate.create', 'candidate.search', 'candidate.edit',
    'application.read', 'application.create', 'application.move',
    'interview.read', 'interview.schedule',
    'offer.read',
    'onboarding.read', 'onboarding.manage',
    'distribution.read', 'distribution.manage',
    'message.read', 'message.send',
    'pool.read', 'pool.manage',
    'sla.read',
    'spec.read'
  ]
}

// Permissions reserved for admin only regardless of other grants
export const ADMIN_ONLY: Permission[] = [
  'admin.users', 'admin.settings', 'candidate.delete', 'automation.manage', 'sla.manage', 'template.manage'
]

export const can = (role: Role, permission: Permission): boolean => {
  if (ADMIN_ONLY.includes(permission) && role !== 'admin') return false
  return (PERMISSIONS[role] || R()).includes(permission)
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrator',
  recruiter: 'Recruiter',
  hiring_manager: 'Hiring Manager',
  interviewer: 'Interviewer',
  coordinator: 'Coordinator'
}

/** Row-level scoping: managers only see requisitions/candidates they are assigned to. */
export const scopeForUser = (user: { id: number; role: Role }) => {
  if (user.role === 'hiring_manager') return { managerScoped: true, userId: user.id }
  return { managerScoped: false, userId: user.id }
}
