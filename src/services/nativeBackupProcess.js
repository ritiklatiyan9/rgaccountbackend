import { spawn } from 'node:child_process';

/** stderr can contain record values; never return or log it. */
export function runNative(binary, args, { env, signal, input = false, output = true } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('Backup cancelled.');
  const child = spawn(binary, args, { env, shell: false, stdio: [input ? 'pipe' : 'ignore', output ? 'pipe' : 'ignore', 'pipe'] });
  let warningBytes = 0;
  child.stderr.on('data', chunk => { warningBytes += chunk.length; });
  let escalation;
  const stop = () => {
    child.kill('SIGTERM');
    escalation ??= setTimeout(() => child.kill('SIGKILL'), 5000);
    escalation.unref();
  };
  signal?.addEventListener('abort', stop, { once: true });
  const done = new Promise((resolve, reject) => {
    child.once('error', () => reject(Object.assign(new Error('PostgreSQL backup tool could not be started. Check its installation and permissions.'), { code: 'BACKUP_TOOL_UNAVAILABLE' })));
    child.once('close', (code, killedBy) => {
      clearTimeout(escalation);
      signal?.removeEventListener('abort', stop);
      if (code !== 0) reject(Object.assign(new Error(`PostgreSQL backup tool failed (${killedBy || code}). Check database privileges, compatibility, connectivity and disk limits.`), { code: 'BACKUP_TOOL_FAILED' }));
      else resolve({ warningBytes });
    });
  });
  // A consumer may still be awaiting storage when the child exits.
  done.catch(() => {});
  return { child, done, stop };
}

export async function nativeVersion(binary, env, signal) {
  const timeout = AbortSignal.timeout(10000);
  const operation = runNative(binary, ['--version'], { env, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  let version = '';
  for await (const chunk of operation.child.stdout) {
    version += chunk.toString('utf8');
    if (version.length > 1024) { operation.stop(); throw new Error('Unexpected PostgreSQL tool version output.'); }
  }
  await operation.done;
  const match = version.match(/\(PostgreSQL\) (\d+)(?:\.\d+)+/);
  if (!match) throw new Error('Unable to identify the PostgreSQL tool version.');
  return { major: Number(match[1]), version: match[0] };
}
