import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';

/**
 * GET /activity/today
 * Fetch paginated sessions for today (logins today OR currently active)
 */
export const getTodayActivity = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // We want sessions where login_time is today OR logout_time is null (active)
    // Let's keep it simple: any session that started today OR is still ongoing.
    const query = `
    SELECT 
      us.id AS session_id,
      us.login_time,
      us.logout_time,
      us.ip_address,
      u.id AS user_id,
      u.name,
      u.role,
      u.photo
    FROM user_sessions us
    JOIN users u ON us.user_id = u.id
    WHERE us.login_time >= current_date
       OR us.logout_time IS NULL
    ORDER BY us.login_time DESC
    LIMIT $1 OFFSET $2
  `;

    const countQuery = `
    SELECT COUNT(*) 
    FROM user_sessions us
    WHERE us.login_time >= current_date
       OR us.logout_time IS NULL
  `;

    const [dataResult, countResult] = await Promise.all([
        pool.query(query, [limit, offset]),
        pool.query(countQuery)
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    res.json({
        activities: dataResult.rows,
        pagination: {
            total,
            page,
            limit,
            totalPages
        }
    });
});
