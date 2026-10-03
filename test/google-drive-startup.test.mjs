import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

test('the actual server module graph links through native ESM without running database startup', async () => {
  // Source-injection unit tests omit import declarations. Use a fresh Node
  // process to catch missing named exports in the real server dependency graph.
  // Leave connectDB pending so no migrations, listeners or workers can start.
  const probe = `
    import pool from './src/config/db.js';
    pool.connect = () => new Promise(() => {});
    pool.query = () => { throw new Error('Startup smoke must not query the database'); };
    globalThis.fetch = () => { throw new Error('Startup smoke must not access the network'); };
    await import('./src/server.js');
    console.log('SERVER_MODULE_GRAPH_LOADED');
    process.exit(0);
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 20000,
  });
  assert.match(stdout, /SERVER_MODULE_GRAPH_LOADED/);
});
