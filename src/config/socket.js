import { Server } from 'socket.io';
import { verifyToken } from './jwt.js';
import pool from './db.js';

let io;

// siteId -> (userId -> number of connected sockets)
const sitePresence = new Map();

const positiveId = (value) => {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
};

const siteRoom = (siteId) => `site_${siteId}`;
const conversationRoom = (siteId, conversationId) =>
    `site_${siteId}:conversation_${conversationId}`;

const canAccessSite = async (userId, siteId) => {
    const result = await pool.query(
        `SELECT 1
           FROM users u
           JOIN sites s ON s.organization_id = u.organization_id
          WHERE u.id = $1
            AND u.is_active = true
            AND s.id = $2
            AND (
              u.role IN ('admin', 'super_admin')
              OR EXISTS (
                SELECT 1 FROM user_sites us
                 WHERE us.user_id = u.id AND us.site_id = s.id
              )
            )
          LIMIT 1`,
        [userId, siteId]
    );
    return Boolean(result.rows[0]);
};

const canAccessConversation = async (userId, siteId, conversationId) => {
    const result = await pool.query(
        `SELECT 1
           FROM conversations c
           JOIN sites s ON s.id = c.site_id
           JOIN users u ON u.id = $1 AND u.organization_id = s.organization_id
          WHERE c.id = $2
            AND c.site_id = $3
            AND u.is_active = true
            AND (c.user1_id = u.id OR c.user2_id = u.id)
            AND (
              u.role IN ('admin', 'super_admin')
              OR EXISTS (
                SELECT 1 FROM user_sites us
                 WHERE us.user_id = u.id AND us.site_id = c.site_id
              )
            )
          LIMIT 1`,
        [userId, conversationId, siteId]
    );
    return Boolean(result.rows[0]);
};

const onlineUsersForSite = (siteId) =>
    [...(sitePresence.get(siteId)?.entries() || [])]
        .filter(([, count]) => count > 0)
        .map(([userId]) => userId);

export const initSocket = (server) => {
    io = new Server(server, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST']
        }
    });

    io.use((socket, next) => {
        const token = socket.handshake.auth.token;
        if (!token) return next(new Error('Authentication error'));

        try {
            socket.user = verifyToken(token);
            next();
        } catch {
            next(new Error('Authentication error'));
        }
    });

    io.on('connection', (socket) => {
        const userId = positiveId(socket.user.id);
        const joinedSites = new Set();

        const leaveSite = (siteId) => {
            if (!joinedSites.has(siteId)) return;

            joinedSites.delete(siteId);
            socket.leave(siteRoom(siteId));
            const users = sitePresence.get(siteId);
            const nextCount = Math.max(0, (users?.get(userId) || 1) - 1);
            if (nextCount > 0) {
                users.set(userId, nextCount);
            } else {
                users?.delete(userId);
                io.to(siteRoom(siteId)).emit('user_offline', { userId, siteId });
            }
            if (users?.size === 0) sitePresence.delete(siteId);
        };

        const joinSite = async (rawSiteId) => {
            const siteId = positiveId(rawSiteId);
            if (!siteId || joinedSites.has(siteId)) return siteId;
            if (!(await canAccessSite(userId, siteId))) return null;

            socket.join(siteRoom(siteId));
            joinedSites.add(siteId);

            const users = sitePresence.get(siteId) || new Map();
            const wasOffline = !users.has(userId);
            users.set(userId, (users.get(userId) || 0) + 1);
            sitePresence.set(siteId, users);

            socket.emit('site_presence', { siteId, userIds: onlineUsersForSite(siteId) });
            if (wasOffline) {
                socket.to(siteRoom(siteId)).emit('user_online', { userId, siteId });
            }
            return siteId;
        };

        socket.on('join_site', async ({ siteId } = {}) => {
            try {
                const joinedSiteId = await joinSite(siteId);
                if (!joinedSiteId) {
                    socket.emit('chat_error', { message: 'Site access denied' });
                }
            } catch (error) {
                console.error('Socket join_site failed:', error);
                socket.emit('chat_error', { message: 'Unable to join site chat' });
            }
        });

        socket.on('leave_site', ({ siteId } = {}) => {
            const parsedSiteId = positiveId(siteId);
            if (parsedSiteId) leaveSite(parsedSiteId);
        });

        socket.on('join_conversation', async ({ conversationId, siteId } = {}) => {
            try {
                const parsedConversationId = positiveId(conversationId);
                const parsedSiteId = await joinSite(siteId);
                if (
                    !parsedSiteId ||
                    !parsedConversationId ||
                    !(await canAccessConversation(userId, parsedSiteId, parsedConversationId))
                ) {
                    socket.emit('chat_error', { message: 'Conversation access denied' });
                    return;
                }
                socket.join(conversationRoom(parsedSiteId, parsedConversationId));
            } catch (error) {
                console.error('Socket join_conversation failed:', error);
                socket.emit('chat_error', { message: 'Unable to join conversation' });
            }
        });

        socket.on('leave_conversation', ({ conversationId, siteId } = {}) => {
            const parsedConversationId = positiveId(conversationId);
            const parsedSiteId = positiveId(siteId);
            if (parsedConversationId && parsedSiteId) {
                socket.leave(conversationRoom(parsedSiteId, parsedConversationId));
            }
        });

        socket.on('typing', ({ conversationId, siteId, isTyping } = {}) => {
            const parsedConversationId = positiveId(conversationId);
            const parsedSiteId = positiveId(siteId);
            if (!parsedConversationId || !parsedSiteId) return;

            const room = conversationRoom(parsedSiteId, parsedConversationId);
            if (!socket.rooms.has(room)) return;
            socket.to(room).emit('typing', {
                userId,
                siteId: parsedSiteId,
                conversationId: parsedConversationId,
                isTyping: Boolean(isTyping)
            });
        });

        socket.on('disconnect', () => {
            for (const siteId of [...joinedSites]) leaveSite(siteId);
        });
    });

    return io;
};

export const getIo = () => {
    if (!io) throw new Error('Socket.io is not initialized!');
    return io;
};

export const emitNewMessage = (siteId, conversationId, message) => {
    if (io) {
        io.to(conversationRoom(siteId, conversationId)).emit('new_message', message);
    }
};
