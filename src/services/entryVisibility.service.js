import permissionModel from '../models/Permission.model.js';

const PRIVILEGED_ROLES = new Set(['admin', 'super_admin']);

export const parseCreatorId = (value) => {
  if (value === undefined || value === null || value === '' || value === 'all') return null;
  const parts = (Array.isArray(value) ? value : String(value).split(',')).map(v => String(v).trim());
  if (!parts.length || parts.some(v => !/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < 1 || Number(v) > 2147483647)) return -1;
  const ids = [...new Set(parts.map(Number))];
  return ids.length === 1 ? ids[0] : ids.join(',');
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

  const requestCache = user?.permissionsByModule;
  const permission = requestCache instanceof Map && requestCache.has(module)
    ? requestCache.get(module)
    : await permissionModel.getPermission(user.id, module);
  if (requestCache instanceof Map && !requestCache.has(module)) {
    requestCache.set(module, permission);
  }
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
