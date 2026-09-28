import pool from '../config/db.js';
import { hashPassword } from '../config/jwt.js';
import asyncHandler from '../utils/asyncHandler.js';

export function createUserPasswordHandlers(db = pool, hash = hashPassword) {
  return {
    async listUsers(req, res) {
      const result = await db.query(
        'SELECT id, name, email, role, is_active FROM users ORDER BY lower(name), id'
      );
      res.set('Cache-Control', 'no-store');
      res.json({ users: result.rows });
    },

    async updatePassword(req, res) {
      const id = Number(req.params.id);
      const password = req.body?.new_password;
      if (!/^\d+$/.test(String(req.params.id)) || !Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({ message: 'Invalid user ID' });
      }
      if (typeof password !== 'string' || password.trim().length < 6) {
        return res.status(400).json({ message: 'Password must contain at least 6 non-padding characters' });
      }
      // bcrypt only uses the first 72 bytes; reject values that would be truncated.
      if (Buffer.byteLength(password, 'utf8') > 72) {
        return res.status(400).json({ message: 'Password must be 72 bytes or fewer' });
      }

      const hashedPassword = await hash(password);
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        // Increment in SQL so concurrent password resets cannot reuse a token version.
        const result = await client.query(
          `UPDATE users SET password = $1, refresh_token = NULL,
             token_version = COALESCE(token_version, 1) + 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 RETURNING id`,
          [hashedPassword, id]
        );
        if (!result.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ message: 'User account not found' });
        }
        await client.query(
          'UPDATE user_sessions SET logout_time = CURRENT_TIMESTAMP WHERE user_id = $1 AND logout_time IS NULL',
          [id]
        );
        await client.query('COMMIT');
        res.json({ message: 'Password updated successfully. This user must sign in again.' });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

const handlers = createUserPasswordHandlers();
export const listPasswordUsers = asyncHandler(handlers.listUsers);
export const updateUserPassword = asyncHandler(handlers.updatePassword);
