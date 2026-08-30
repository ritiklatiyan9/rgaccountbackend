import pool from '../config/db.js';

// Canonical module keys used by both frontend route guards and backend middleware.
// Keep this list additive: ensureDefaults() safely seeds newly introduced modules
// for every existing sub-admin without overwriting their current choices.
export const ALL_MODULES = Object.freeze([
    'dashboard',
    'finance_forecast',
    'clients',
    'vendors',
    'farmers',
    'commissions',
    'daybook',
    'balance_sheet',
    'cashflow',
    'firm_transactions',
    'plot_payments',
    'plot_registry',
    'document_search',
    'expenses',
    'expense_approval',
    'imprest',
    'document_imprest',
    'upi_collect',
    'construction',
    'inventory',
    'chat',
    'excel',
    'reports',
    'settings',
    // Compliance and legal are split so sensitive legal matters, template
    // administration and module settings can be granted independently.
    'compliance',
    'legal',
    'compliance_templates',
    'compliance_settings',
    'audit_logs',
    'recycle_bin',
    // Whole-site management aggregates (read-only). A grant reveals site-wide totals, so opt-in only.
    'management_analytics',
    // Miscellaneous income (maintenance, tokens, gifts…) — money module, admin opts sub-admins in.
    'misc_income',
]);

const READ_ONLY_MODULES = new Set(['dashboard', 'finance_forecast', 'balance_sheet', 'reports', 'settings', 'audit_logs', 'management_analytics']);
// Modules introduced after the original permission rollout stay fail-closed for
// existing sub-admins. An administrator must opt users into these sensitive
// document/payment surfaces from the permission matrix.
const RESTRICTED_MODULES = new Set([
    'expense_approval',
    'document_search',
    'document_imprest',
    'upi_collect',
    // New money-touching modules (budgets, inventory valuation) — stay
    // fail-closed for existing sub-admins; an admin opts users in.
    'construction',
    'inventory',
    // Compliance & legal surfaces carry regulatory and litigation records —
    // fail closed until an administrator opts a sub-admin in.
    'compliance',
    'legal',
    'compliance_templates',
    'compliance_settings',
    // Cross-module activity is sensitive and stays opt-in for sub-admins.
    'audit_logs',
    'recycle_bin',
    'management_analytics',
    'misc_income',
]);

const getDefaultPermissions = (module) => {
    if (RESTRICTED_MODULES.has(module)) {
        return { can_read: false, can_write: false, can_update: false, can_delete: false, can_restore: false, can_view_all: false };
    }
    if (READ_ONLY_MODULES.has(module)) {
        return { can_read: true, can_write: false, can_update: false, can_delete: false, can_restore: false, can_view_all: false };
    }
    return { can_read: true, can_write: true, can_update: true, can_delete: false, can_restore: false, can_view_all: false };
};

class PermissionModel {
    /** Get all permissions for a user */
    async getByUserId(userId) {
        await this.ensureDefaults(userId);
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
            return this.upsert(userId, module, getDefaultPermissions(module));
        }

        return null;
    }

    /** Upsert a single module permission */
    async upsert(userId, module, permissions, db = pool) {
        if (!ALL_MODULES.includes(module)) {
            throw new Error(`Unknown permission module: ${module}`);
        }
        const query = `
      INSERT INTO user_permissions (user_id, module, can_read, can_write, can_update, can_delete, can_restore, can_view_all, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (user_id, module)
      DO UPDATE SET
        can_read = EXCLUDED.can_read,
        can_write = EXCLUDED.can_write,
        can_update = EXCLUDED.can_update,
        can_delete = EXCLUDED.can_delete,
        can_restore = EXCLUDED.can_restore,
        can_view_all = EXCLUDED.can_view_all,
        updated_at = NOW()
      RETURNING *
    `;
        const defaults = getDefaultPermissions(module);
        const result = await db.query(query, [
            userId,
            module,
            permissions.can_read ?? defaults.can_read,
            permissions.can_write ?? defaults.can_write,
            permissions.can_update ?? defaults.can_update,
            permissions.can_delete ?? defaults.can_delete,
            permissions.can_restore ?? defaults.can_restore,
            permissions.can_view_all ?? defaults.can_view_all,
        ]);
        return result.rows[0];
    }

    /** Bulk upsert permissions for a user (from admin page) */
    async bulkUpsert(userId, permissionsArray) {
        const client = await pool.connect();
        const results = [];
        try {
            await client.query('BEGIN');
            for (const perm of permissionsArray) {
                const result = await this.upsert(userId, perm.module, perm, client);
                results.push(result);
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
        return results;
    }

    /** Seed missing modules without changing any permissions already configured. */
    async ensureDefaults(userId) {
        const modules = ALL_MODULES.map(module => ({ module, ...getDefaultPermissions(module) }));
        await pool.query(
            `INSERT INTO user_permissions
               (user_id, module, can_read, can_write, can_update, can_delete, can_restore, can_view_all)
             SELECT $1, x.module, x.can_read, x.can_write, x.can_update, x.can_delete, x.can_restore, x.can_view_all
             FROM jsonb_to_recordset($2::jsonb) AS x(
               module text,
               can_read boolean,
               can_write boolean,
               can_update boolean,
               can_delete boolean,
               can_restore boolean,
               can_view_all boolean
             )
             ON CONFLICT (user_id, module) DO NOTHING`,
            [userId, JSON.stringify(modules)]
        );
    }

    /** Create default permissions for a new sub-admin. */
    async createDefaults(userId) {
        await this.ensureDefaults(userId);
        return this.getByUserId(userId);
    }

    /** Get modules list */
    static get ALL_MODULES() {
        return ALL_MODULES;
    }
}

export default new PermissionModel();
