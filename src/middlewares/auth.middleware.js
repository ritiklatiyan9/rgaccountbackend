import { verifyToken } from '../config/jwt.js';
import pool from '../config/db.js';

const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded = verifyToken(token);
    const sessionIdHeader = req.header('X-Session-ID');

    const userResult = await pool.query(
      'SELECT id, token_version, is_active FROM users WHERE id = $1 LIMIT 1',
      [decoded.id]
    );

    const dbUser = userResult.rows[0];
    if (!dbUser || !dbUser.is_active) {
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    }

    if (decoded.version !== dbUser.token_version) {
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    }

    if (sessionIdHeader) {
      const sessionId = parseInt(sessionIdHeader, 10);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(401).json({ message: 'Invalid session context' });
      }

      const sessionResult = await pool.query(
        `SELECT id, logout_time
         FROM user_sessions
         WHERE id = $1 AND user_id = $2
         LIMIT 1`,
        [sessionId, decoded.id]
      );

      if (!sessionResult.rows[0] || sessionResult.rows[0].logout_time) {
        return res.status(401).json({ message: 'Session expired. Please login again.' });
      }

      req.sessionId = sessionId;
    }

    // decoded contains: id, email, role, version
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
};

export default authMiddleware;