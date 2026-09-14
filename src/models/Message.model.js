import MasterModel from './MasterModel.js';

class MessageModel extends MasterModel {
    constructor() {
        super('messages');
    }

    /**
     * Get all messages for a specific conversation
     */
    async getMessagesByConversationId(conversationId, siteId, pool) {
        const query = `
      SELECT m.*, u.name as sender_name, u.photo as sender_photo
      FROM ${this.tableName} m
      JOIN users u ON m.sender_id = u.id
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1 AND c.site_id = $2
      ORDER BY m.created_at ASC
    `;
        const result = await pool.query(query, [conversationId, siteId]);
        return result.rows;
    }

    /**
     * Create a new message
     */
    async createMessage(conversationId, senderId, siteId, text, attachmentUrl, pool) {
        const query = `
      INSERT INTO ${this.tableName} (conversation_id, sender_id, message_text, attachment_url)
      SELECT c.id, $2, $4, $5
      FROM conversations c
      WHERE c.id = $1 AND c.site_id = $3 AND (c.user1_id = $2 OR c.user2_id = $2)
      RETURNING *
    `;
        const result = await pool.query(query, [
            conversationId,
            senderId,
            siteId,
            text || null,
            attachmentUrl || null
        ]);
        return result.rows[0] || null;
    }

    /**
     * Mark all unread messages in a conversation as read for a specific user
     * (The user marking them read is the receiver, so we update where sender != userId)
     */
    async markAsRead(conversationId, userId, siteId, pool) {
        const query = `
      UPDATE ${this.tableName}
      SET is_read = TRUE
      WHERE conversation_id = $1 AND sender_id != $2 AND is_read = FALSE
        AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id AND c.site_id = $3)
      RETURNING *
    `;
        const result = await pool.query(query, [conversationId, userId, siteId]);
        return result.rowCount; // return number of updated rows
    }

    /**
     * Delete a message (For Admin feature)
     */
    async deleteMessage(messageId, siteId, pool) {
        const query = `DELETE FROM ${this.tableName} m
          WHERE m.id = $1
            AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = m.conversation_id AND c.site_id = $2)
          RETURNING m.*`;
        const result = await pool.query(query, [messageId, siteId]);
        return result.rows[0];
    }

}

export default new MessageModel();
