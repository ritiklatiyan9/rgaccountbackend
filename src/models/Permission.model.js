import pool from '../config/db.js';

// All modules that sub-admins can access
const ALL_MODULES = [
    'dashboard', 'clients', 'vendors', 'farmers', 'commissions', 'daybook', 'balance_sheet',
    'cashflow', 'firm_transactions', 'plot_payments', 'plot_registry',
    'expenses', 'imprest', 'reports', 'settings', 'chat', 'excel',
    'expense_approval',
];

class PermissionModel {
    /** Get all permissions for a user */
    async getByUserId(userId) {
        const query = `SELECT * FROM user_permissions WHERE user_id = $1 ORDER BY module`;
        const result = await pool.query(query, [userId]);
        return result.rows;
    }

    /** Get permission for a specific user + module */
    async getPermission(userId, module) {
        const query = `SELECT * FROM user_permissions WHERE user_id = $1 AND module = $2`;
        const result = await pool.query(query, [userId, module]);
        if (result.rows[0]) return result.rows[0];

        // Auto-seed newly added modules for existing sub-admins.
        if (ALL_MODULES.includes(module)) {
            // Sensitive modules default to no access — admin must grant explicitly
            const RESTRICTED_MODULES = ['expense_approval'];
            const restricted = RESTRICTED_MODULES.includes(module);
            return this.upsert(userId, module, {
                can_read: !restricted,
                can_write: !restricted,
                can_update: !restricted,
                can_delete: false,
            });
        }

        return null;
    }

    /** Upsert a single module permission */
    async upsert(userId, module, permissions) {
        const query = `
      INSERT INTO user_permissions (user_id, module, can_read, can_write, can_update, can_delete, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (user_id, module)
      DO UPDATE SET
        can_read = EXCLUDED.can_read,
        can_write = EXCLUDED.can_write,
        can_update = EXCLUDED.can_update,
        can_delete = EXCLUDED.can_delete,
        updated_at = NOW()
      RETURNING *
    `;
        const result = await pool.query(query, [
            userId,
            module,
            permissions.can_read ?? true,
            permissions.can_write ?? true,
            permissions.can_update ?? true,
            permissions.can_delete ?? false,
        ]);
        return result.rows[0];
    }

    /** Bulk upsert permissions for a user (from admin page) */
    async bulkUpsert(userId, permissionsArray) {
        const results = [];
        for (const perm of permissionsArray) {
            const result = await this.upsert(userId, perm.module, perm);
            results.push(result);
        }
        return results;
    }

    /** Create default permissions for a new sub-admin (delete OFF) */
    async createDefaults(userId) {
        const defaults = ALL_MODULES.map(module => ({
            module,
            can_read: true,
            can_write: true,
            can_update: true,
            can_delete: false,
        }));
        return this.bulkUpsert(userId, defaults);
    }

    /** Get modules list */
    static get ALL_MODULES() {
        return ALL_MODULES;
    }
}

export default new PermissionModel();
