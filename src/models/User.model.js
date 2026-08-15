import MasterModel from './MasterModel.js';

class UserModel extends MasterModel {
  constructor() {
    super('users');
  }

  async findByEmail(email, pool) {
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    if (!normalizedEmail) return undefined;

    const query = `SELECT * FROM ${this.tableName} WHERE lower(btrim(email)) = $1 LIMIT 1`;
    const result = await pool.query(query, [normalizedEmail]);
    return result.rows[0];
  }

  /** Find an account by the numeric ID shown in User ID Management or by email. */
  async findByLoginIdentifier(identifier, pool) {
    const normalizedIdentifier = String(identifier ?? '').trim();
    if (!normalizedIdentifier) return undefined;

    const idMatch = normalizedIdentifier.match(/^#?(\d+)$/);
    if (idMatch) {
      const userId = Number(idMatch[1]);
      if (!Number.isSafeInteger(userId) || userId <= 0) return undefined;
      return this.findById(userId, pool);
    }

    return this.findByEmail(normalizedIdentifier, pool);
  }

  /** Get all managed users (admins + sub-admins) created by a specific admin */
  async findManagedUsersByCreator(adminId, pool) {
    const query = `
      SELECT id, name, email, phone, photo, role, is_active, created_at, updated_at
      FROM ${this.tableName}
      WHERE created_by = $1
        AND role IN ('admin', 'sub_admin')
      ORDER BY created_at DESC
    `;
    const result = await pool.query(query, [adminId]);
    return result.rows;
  }

  /** Backward compatibility alias */
  async findSubAdminsByCreator(adminId, pool) {
    return this.findManagedUsersByCreator(adminId, pool);
  }

  /** Check if any admin exists in the system */
  async adminExists(pool) {
    const query = `SELECT id FROM ${this.tableName} WHERE role IN ('admin', 'super_admin') LIMIT 1`;
    const result = await pool.query(query);
    return result.rows.length > 0;
  }

  /** List active approvers (all active admins + super_admin) */
  async findActiveAdmins(pool) {
    const query = `
      SELECT id, name, email, phone, role
      FROM ${this.tableName}
      WHERE role IN ('admin', 'super_admin') AND is_active = true
      ORDER BY name ASC
    `;
    const result = await pool.query(query);
    return result.rows;
  }

  /** Safe user object (no password / tokens) */
  sanitize(user) {
    if (!user) return null;
    const { password, refresh_token, token_version, ...safe } = user;
    return safe;
  }

  /** Get assigned site IDs for a user */
  async getAssignedSiteIds(userId, pool) {
    const query = `SELECT site_id FROM user_sites WHERE user_id = $1`;
    const result = await pool.query(query, [userId]);
    return result.rows.map(r => r.site_id);
  }
}

export default new UserModel();
