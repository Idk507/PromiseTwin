import { ASSIGNABLE_ROLES, type Role } from '../domain/contract';
import type { JiraPermissions } from './ports';

/**
 * Effective roles = roles a project administrator ASSIGNED in the app, plus APPROVER derived from
 * the user's own Jira project-administration permission (checked server-side as that user).
 * Default deny: no assignment and no admin right => no roles => read-only.
 * SYSTEM is never produced here. Separation of duties is still enforced inside the domain.
 */
export function resolveRoles(perms: JiraPermissions, assigned: readonly Role[]): Role[] {
  // Only assignable roles are honoured even if storage contains something else (corruption, tampering).
  const roles = new Set<Role>(assigned.filter((r) => (ASSIGNABLE_ROLES as readonly Role[]).includes(r)));
  if (perms.administerProject) roles.add('APPROVER');
  return [...roles];
}
