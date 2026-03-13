import express from 'express';
import {
    getUsers,
    getConversations,
    getOrCreateConversation,
    getMessages,
    sendMessage,
    deleteMessage
} from '../controllers/chat.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

const router = express.Router();

// All chat routes require authentication
router.use(authMiddleware);

router.get('/users', getUsers);
router.get('/conversations', getConversations);
router.get('/conversations/:userId', getOrCreateConversation); // Start a chat
router.get('/messages/:conversationId', getMessages);
router.post('/messages', sendMessage);

// Admin only routes
// We check if requireAdmin or similar exists in role middleware
router.delete('/messages/:messageId', requireRole('admin'), deleteMessage);

export default router;
