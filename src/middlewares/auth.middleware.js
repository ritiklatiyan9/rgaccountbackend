import { verifyToken } from '../config/jwt.js';
import pool from '../config/db.js';

// A screen commonly starts several authenticated requests at the same time.
// When the database is remote, independently validating the same user/session
// for every request creates a connection-pool stampede before route work even
// begins. Share only the in-flight lookup (there is deliberately no TTL cache),
// so logout, deactivation and token-version changes remain visible on the very
// next request once the current lookup finishes.
export const createAuthStateLoader = (db) => {
  const pendingAuthLookups = new Map();

  return (userId, sessionId) => {
    const key = `${userId}:${sessionId ?? 'none'}`;
    const existing = pendingAuthLookups.get(key);
    if (existing) return existing;

    const pending = (async () => {
      try {
        const result = await db.query(
        `SELECT u.id, u.token_version, u.is_active, u.organization_id,
                s.id AS session_id, s.logout_time AS session_logout_time
           FROM users u
           LEFT JOIN user_sessions s
             ON s.id = $2::integer AND s.user_id = u.id
          WHERE u.id = $1
          LIMIT 1`,
        [userId, sessionId]
      );
        return result.rows[0] || null;
      } finally {
        pendingAuthLookups.delete(key);
      }
    })();

    pendingAuthLookups.set(key, pending);
    return pending;
  };
};

const loadAuthState = createAuthStateLoader(pool);

const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded = verifyToken(token);
    const sessionIdHeader = req.header('X-Session-ID');
    let sessionId = null;
    if (sessionIdHeader && decoded.role !== 'super_admin') {
      sessionId = parseInt(sessionIdHeader, 10);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(401).json({ message: 'Invalid session context' });
      }
    }

    const dbUser = await loadAuthState(decoded.id, sessionId);
    if (!dbUser || !dbUser.is_active) {
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    }

    if (decoded.version !== dbUser.token_version) {
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    }

    if (sessionId !== null) {
      if (!dbUser.session_id || dbUser.session_logout_time) {
        return res.status(401).json({ message: 'Session expired. Please login again.' });
      }

      req.sessionId = sessionId;
    }

    // decoded contains: id, email, role, version
    req.user = {
      ...decoded,
      organization_id: dbUser.organization_id || 1,
      // Request-scoped only. Downstream permission and visibility checks can
      // reuse a permission row already loaded by route middleware.
      permissionsByModule: new Map(),
    };
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
};

export default authMiddleware;
