import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import Conversation from '../src/models/Conversation.model.js';

const baselineSql = `SELECT c.id as conversation_id, c.site_id, c.created_at as conversation_created_at,
  u.id as user_id, u.name as user_name, u.photo as user_photo,
  (SELECT message_text FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
  (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != $1 AND m.is_read = FALSE) as unread_count
  FROM conversations c JOIN users u ON u.id = CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END
  JOIN users participant_user ON participant_user.id = $1 AND participant_user.organization_id = u.organization_id
  WHERE (c.user1_id = $1 OR c.user2_id = $1) AND (c.site_id = $2 OR c.site_id IS NULL)
  ORDER BY COALESCE((SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1), c.created_at) DESC`;

test('chat list reuses latest message and preserves previews, unread counts and site/organization scope', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE users(id int PRIMARY KEY, name text, photo text, organization_id int);
      CREATE TABLE conversations(id int PRIMARY KEY, user1_id int, user2_id int, site_id int, created_at timestamp);
      CREATE TABLE messages(id int PRIMARY KEY, conversation_id int, sender_id int, message_text text, created_at timestamp, is_read boolean);
      INSERT INTO users SELECT n,'User '||n,NULL,CASE WHEN n=30 THEN 2 ELSE 1 END FROM generate_series(1,30) n;
      INSERT INTO conversations SELECT n,1,n+1,1,TIMESTAMP '2026-01-01' + n * INTERVAL '1 day' FROM generate_series(1,20) n;
      INSERT INTO conversations VALUES(21,1,22,NULL,'2026-02-01'),(22,1,23,2,'2026-02-01'),(23,1,30,1,'2026-02-01');
      INSERT INTO messages SELECT n,1+(n%20),CASE WHEN n%2=0 THEN 1 ELSE 2 END,'Message '||n,
        TIMESTAMP '2026-01-01' + n * INTERVAL '1 minute',n%3=0 FROM generate_series(1,4000) n;`);
    let sql; let params;
    const tracked = { query: (query, values) => { sql = query; params = values; return db.query(query, values); } };
    const result = await Conversation.getUserConversations(1, 1, tracked);
    assert.deepEqual(result, (await db.query(baselineSql, [1, 1])).rows);
    assert.equal(result.length, 21);
    assert.equal(result.some(row => row.conversation_id === 22 || row.conversation_id === 23), false);
    const empty = result.find(row => row.conversation_id === 21);
    assert.equal(empty.last_message, null);
    assert.equal(empty.unread_count, 0);
    const scans = async query => {
      const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, params);
      const found = [];
      const walk = node => { if (node['Relation Name'] === 'messages') found.push(node); (node.Plans || []).forEach(walk); };
      walk(rows[0]['QUERY PLAN'][0].Plan);
      return found;
    };
    const before = await scans(baselineSql);
    const after = await scans(sql);
    assert.equal(before.length, 4, 'three latest-message lookups plus unread count');
    assert.equal(after.length, 2, 'one latest-message lookup plus unread count');
    assert.equal(before.reduce((sum, node) => sum + node['Actual Loops'], 0), 84);
    assert.equal(after.reduce((sum, node) => sum + node['Actual Loops'], 0), 42);
  } finally { await db.close(); }
});
