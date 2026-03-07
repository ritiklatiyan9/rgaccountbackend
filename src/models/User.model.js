import MasterModel from './MasterModel.js';

class UserModel extends MasterModel {
  constructor() {
    super('users');
  }

  async findByEmail(email, pool) {
    const query = `SELECT * FROM ${this.tableName} WHERE email = $1`;
    const result = await pool.query(query, [email]);
    return result.rows[0];
  }

  /** Get all sub-admins created by a specific admin */
  async findSubAdminsByCreator(adminId, pool) {
    const query = `
      SELECT id, name, email, phone, photo, role, is_active, created_at, updated_at
      FROM ${this.tableName}
      WHERE created_by = $1
      ORDER BY created_at DESC
    `;
    const result = await pool.query(query, [adminId]);
    return result.rows;
  }

  /** Check if any admin exists in the system */
  async adminExists(pool) {
    const query = `SELECT id FROM ${this.tableName} WHERE role = 'admin' LIMIT 1`;
    const result = await pool.query(query);
    return result.rows.length > 0;
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