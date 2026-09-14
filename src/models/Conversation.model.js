import MasterModel from './MasterModel.js';

class ConversationModel extends MasterModel {
    constructor() {
        super('conversations');
    }

    /**
     * Find or create a conversation between two users
     */
    async findOrCreateConversation(user1Id, user2Id, siteId, pool) {
        // Ensure smaller ID is always user1 to prevent duplicates like (1,2) and (2,1)
        const u1 = Math.min(user1Id, user2Id);
        const u2 = Math.max(user1Id, user2Id);

        try {
            const createQuery = `
        INSERT INTO ${this.tableName} (user1_id, user2_id, site_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (site_id, user1_id, user2_id) WHERE site_id IS NOT NULL
        DO UPDATE SET site_id = EXCLUDED.site_id
        RETURNING *
      `;
            const createResult = await pool.query(createQuery, [u1, u2, siteId]);
            return createResult.rows[0];
        } catch (err) {
            throw err;
        }
    }

    /**
     * Get all conversations for a specific user
     * Joins with users table to get the OTHER user's details
     */
    async getUserConversations(userId, siteId, pool) {
        const query = `
      SELECT 
        c.id as conversation_id,
        c.created_at as conversation_created_at,
        u.id as user_id,
        u.name as user_name,
        u.photo as user_photo,
        -- Get latest message for preview
        (SELECT message_text FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
        -- Get unread count for this user
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != $1 AND m.is_read = FALSE) as unread_count
      FROM ${this.tableName} c
      JOIN users u ON (u.id = CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END)
      WHERE (c.user1_id = $1 OR c.user2_id = $1)
        AND c.site_id = $2
      ORDER BY COALESCE((SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1), c.created_at) DESC
    `;
        const result = await pool.query(query, [userId, siteId]);
        return result.rows;
    }

    async findForParticipant(conversationId, userId, siteId, pool) {
        const result = await pool.query(
            `SELECT * FROM ${this.tableName}
             WHERE id = $1 AND site_id = $2 AND (user1_id = $3 OR user2_id = $3)
             LIMIT 1`,
            [conversationId, siteId, userId]
        );
        return result.rows[0] || null;
    }
}

export default new ConversationModel();
