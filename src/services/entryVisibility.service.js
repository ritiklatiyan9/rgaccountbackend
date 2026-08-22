import permissionModel from '../models/Permission.model.js';

const PRIVILEGED_ROLES = new Set(['admin', 'super_admin']);

export const parseCreatorId = (value) => {
  if (value === undefined || value === null || value === '' || value === 'all') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Resolve the creator constraint that must be applied to a transaction query.
 * A caller-supplied creator is honored only for privileged users or sub-admins
 * with can_view_all on the owning module. Everyone else is forced to self.
 */
export const resolveEntryVisibility = async (user, module, requestedCreatorId) => {
  const requested = parseCreatorId(requestedCreatorId);
  if (PRIVILEGED_ROLES.has(user?.role)) {
    return { canViewAll: true, creatorId: requested };
  }

  if (user?.role !== 'sub_admin') {
    return { canViewAll: false, creatorId: Number(user?.id) || -1 };
  }

  const permission = await permissionModel.getPermission(user.id, module);
  const canViewAll = permission?.can_view_all === true;
  return {
    canViewAll,
    creatorId: canViewAll ? requested : Number(user.id),
  };
};

export const canUserViewEntry = async (user, module, createdBy) => {
  const scope = await resolveEntryVisibility(user, module, null);
  if (scope.canViewAll) return true;
  return Number(createdBy) === Number(scope.creatorId);
};

