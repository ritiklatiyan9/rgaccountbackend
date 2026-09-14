import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Conversation from '../src/models/Conversation.model.js';
import Message from '../src/models/Message.model.js';

test('conversation creation is unique within a site and canonicalizes participants', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 42, site_id: 7 }] };
    },
  };

  const conversation = await Conversation.findOrCreateConversation(19, 3, 7, db);
  assert.equal(conversation.site_id, 7);
  assert.deepEqual(calls[0].params, [3, 19, 7]);
  assert.match(calls[0].sql, /ON CONFLICT \(site_id, user1_id, user2_id\)/);
});

test('conversation and message reads carry the selected site id', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };

  await Conversation.getUserConversations(11, 5, db);
  await Message.getMessagesByConversationId(91, 5, db);
  await Message.markAsRead(91, 11, 5, db);

  assert.deepEqual(calls.map(({ params }) => params), [[11, 5], [91, 5], [91, 11, 5]]);
  calls.forEach(({ sql }) => assert.match(sql, /site_id/));
});

test('message writes require both site ownership and conversation participation', async () => {
  let captured;
  const db = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    },
  };

  const result = await Message.createMessage(22, 8, 4, 'hello', null, db);
  assert.equal(result, null);
  assert.deepEqual(captured.params, [22, 8, 4, 'hello', null]);
  assert.match(captured.sql, /c\.site_id = \$3/);
  assert.match(captured.sql, /c\.user1_id = \$2 OR c\.user2_id = \$2/);
});

test('realtime rooms and migration are site-scoped contracts', async () => {
  const [socketSource, migrationSource] = await Promise.all([
    readFile(new URL('../src/config/socket.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/migrations/170_chat_site_scope.js', import.meta.url), 'utf8'),
  ]);

  assert.match(socketSource, /site_\$\{siteId\}:conversation_\$\{conversationId\}/);
  assert.match(socketSource, /canAccessConversation/);
  assert.match(socketSource, /site_presence/);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS site_id/);
  assert.match(migrationSource, /CHECK \(site_id IS NOT NULL\) NOT VALID/);
  assert.match(migrationSource, /uq_conversations_site_users/);
});
