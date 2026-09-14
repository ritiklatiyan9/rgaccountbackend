import pool from '../config/db.js';
import Conversation from '../models/Conversation.model.js';
import Message from '../models/Message.model.js';
import { emitNewMessage } from '../config/socket.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

const parsePositiveId = (value) => {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
};

const requestedSiteId = (req) => parsePositiveId(req.query.site_id ?? req.body?.site_id);

const requireAccessibleSite = async (req, res) => {
    const siteId = requestedSiteId(req);
    if (!siteId) {
        res.status(400).json({ message: 'A valid site_id is required' });
        return null;
    }

    const result = await pool.query(
        `SELECT s.id, s.name
           FROM sites s
          WHERE s.id = $1
            AND s.organization_id = $2
            AND (
              $3::text IN ('admin', 'super_admin')
              OR EXISTS (
                SELECT 1 FROM user_sites us
                 WHERE us.site_id = s.id AND us.user_id = $4
              )
            )
          LIMIT 1`,
        [siteId, Number(req.user.organization_id) || 1, req.user.role, req.user.id]
    );

    if (!result.rows[0]) {
        res.status(403).json({ message: 'You do not have access to this site' });
        return null;
    }
    return result.rows[0];
};

export const getUsers = async (req, res) => {
    try {
        const site = await requireAccessibleSite(req, res);
        if (!site) return;

        const result = await pool.query(
            `SELECT u.id, u.name, u.email, u.role, u.photo
               FROM users u
              WHERE u.id != $1
                AND u.is_active = true
                AND u.organization_id = $2
                AND (
                  u.role IN ('admin', 'super_admin')
                  OR EXISTS (
                    SELECT 1 FROM user_sites us
                     WHERE us.user_id = u.id AND us.site_id = $3
                  )
                )
              ORDER BY u.name ASC`,
            [req.user.id, Number(req.user.organization_id) || 1, site.id]
        );

        res.status(200).json({ users: result.rows });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

export const getConversations = async (req, res) => {
    try {
        const site = await requireAccessibleSite(req, res);
        if (!site) return;

        const conversations = await Conversation.getUserConversations(req.user.id, site.id, pool);
        res.status(200).json({ conversations });
    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

export const getOrCreateConversation = async (req, res) => {
    try {
        const site = await requireAccessibleSite(req, res);
        if (!site) return;

        const currentUserId = parsePositiveId(req.user.id);
        const otherUserId = parsePositiveId(req.params.userId);
        if (!otherUserId) {
            return res.status(400).json({ message: 'A valid user is required' });
        }
        if (currentUserId === otherUserId) {
            return res.status(400).json({ message: 'Cannot create conversation with yourself' });
        }

        const targetResult = await pool.query(
            `SELECT u.id
               FROM users u
              WHERE u.id = $1
                AND u.is_active = true
                AND u.organization_id = $2
                AND (
                  u.role IN ('admin', 'super_admin')
                  OR EXISTS (
                    SELECT 1 FROM user_sites us
                     WHERE us.user_id = u.id AND us.site_id = $3
                  )
                )
              LIMIT 1`,
            [otherUserId, Number(req.user.organization_id) || 1, site.id]
        );
        if (!targetResult.rows[0]) {
            return res.status(404).json({ message: 'User is not available for this site' });
        }

        const conversation = await Conversation.findOrCreateConversation(
            currentUserId,
            otherUserId,
            site.id,
            pool
        );
        res.status(200).json({ conversation });
    } catch (error) {
        console.error('Error finding/creating conversation:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

export const getMessages = async (req, res) => {
    try {
        const site = await requireAccessibleSite(req, res);
        if (!site) return;

        const conversationId = parsePositiveId(req.params.conversationId);
        if (!conversationId) {
            return res.status(400).json({ message: 'A valid conversation is required' });
        }

        const conversation = await Conversation.findForParticipant(
            conversationId,
            req.user.id,
            site.id,
            pool
        );
        if (!conversation) {
            return res.status(404).json({ message: 'Conversation not found for this site' });
        }

        await Message.markAsRead(conversationId, req.user.id, site.id, pool);
        const messages = await Message.getMessagesByConversationId(conversationId, site.id, pool);
        res.status(200).json({ messages });
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

export const sendMessage = async (req, res) => {
    try {
        const site = await requireAccessibleSite(req, res);
        if (!site) return;

        const senderId = req.user.id;
        const conversationId = parsePositiveId(req.body.conversationId);
        const { text, attachmentUrl } = req.body;
        if (!conversationId) {
            return res.status(400).json({ message: 'A valid conversation is required' });
        }
        if (!text && !attachmentUrl) {
            return res.status(400).json({ message: 'Message text or attachment is required' });
        }

        const message = await Message.createMessage(
            conversationId,
            senderId,
            site.id,
            text,
            attachmentUrl,
            pool
        );
        if (!message) {
            return res.status(404).json({ message: 'Conversation not found for this site' });
        }

        const detailsResult = await pool.query(
            `SELECT m.*, u.name AS sender_name, u.photo AS sender_photo
               FROM messages m
               JOIN users u ON m.sender_id = u.id
               JOIN conversations c ON c.id = m.conversation_id
              WHERE m.id = $1 AND c.site_id = $2`,
            [message.id, site.id]
        );
        const finalMessage = detailsResult.rows[0];

        emitNewMessage(site.id, conversationId, finalMessage);
        res.status(201).json({ message: finalMessage });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

export const deleteMessage = async (req, res) => {
    try {
        const site = await requireAccessibleSite(req, res);
        if (!site) return;

        if (!ADMIN_ROLES.has(req.user.role)) {
            return res.status(403).json({ message: 'Only admins can delete messages' });
        }

        const messageId = parsePositiveId(req.params.messageId);
        if (!messageId) {
            return res.status(400).json({ message: 'A valid message is required' });
        }
        const deleted = await Message.deleteMessage(messageId, site.id, pool);
        if (!deleted) {
            return res.status(404).json({ message: 'Message not found for this site' });
        }
        res.status(200).json({ message: 'Message deleted successfully' });
    } catch (error) {
        console.error('Error deleting message:', error);
        res.status(500).json({ message: 'Server error' });
    }
};
