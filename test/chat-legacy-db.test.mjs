import test from 'node:test';
import assert from 'node:assert/strict';
import Conversation from '../src/models/Conversation.model.js';
import Message from '../src/models/Message.model.js';
import { up } from '../src/migrations/170_chat_site_scope.js';

test('migration preserves ambiguous chats as read-only legacy conversations', {
  skip: !process.env.PGLITE_MODULE && 'Set PGLITE_MODULE to run the database integration test',
}, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  const query = (sql, params) => db.query(sql, params);
  const adapter = { query, connect: async () => ({ query, release() {} }) };

  try {
    await db.exec(`CREATE TABLE app_schema_migrations(version TEXT PRIMARY KEY);
      CREATE TABLE sites(id INTEGER PRIMARY KEY, organization_id INTEGER);
      CREATE TABLE users(id INTEGER PRIMARY KEY, organization_id INTEGER, role TEXT, name TEXT, photo TEXT);
      CREATE TABLE user_sites(user_id INTEGER, site_id INTEGER);
      CREATE TABLE conversations(id SERIAL PRIMARY KEY, user1_id INTEGER, user2_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(user1_id, user2_id));
      CREATE TABLE messages(id SERIAL PRIMARY KEY, conversation_id INTEGER, sender_id INTEGER,
        message_text TEXT, attachment_url TEXT, is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO sites VALUES (1, 1), (2, 1);
      INSERT INTO users VALUES (10, 1, 'admin', 'Alice', NULL),
        (11, 1, 'admin', 'Bob', NULL), (12, 2, 'admin', 'Other org', NULL);
      INSERT INTO conversations(user1_id, user2_id) VALUES (10, 11), (10, 12);
      INSERT INTO messages(conversation_id, sender_id, message_text) VALUES (1, 11, 'legacy');`);

    await up(adapter);

    const chats = await Conversation.getUserConversations(10, 1, adapter);
    assert.equal(chats.length, 1);
    assert.equal(chats[0].site_id, null);
    assert.equal((await Conversation.findForParticipant(1, 10, 1, adapter)).id, 1);
    assert.equal(await Conversation.findForParticipant(1, 12, 1, adapter), null);
    assert.equal(await Conversation.findForParticipant(2, 10, 1, adapter), null);
    assert.equal((await Message.getMessagesByConversationId(1, 1, adapter)).length, 1);
    await Message.markAsRead(1, 10, 1, adapter);
    assert.equal((await Message.getMessagesByConversationId(1, 1, adapter))[0].is_read, true);
    assert.equal(await Message.createMessage(1, 10, 1, 'new message', null, adapter), null);

    const newChat = await Conversation.findOrCreateConversation(10, 11, 1, adapter);
    assert.equal(newChat.site_id, 1);
    assert.equal((await Conversation.getUserConversations(10, 1, adapter)).length, 2);
  } finally {
    await db.close();
  }
});
