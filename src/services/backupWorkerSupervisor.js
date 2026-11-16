import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workerFile = fileURLToPath(new URL('../workers/backupWorker.js', import.meta.url));

/** Optional separate process on existing compute. No backup extraction runs in the API. */
export function startBackupWorkerSupervisor({ env = process.env, spawnProcess = spawn, log = value => console.log(JSON.stringify(value)),
  schedule = setTimeout, unschedule = clearTimeout } = {}) {
  let child; let restart; let stopping = false;
  const enabled = env.BACKUP_ENABLED === 'true' && env.BACKUP_WORKER_MODE === 'shared' && env.BACKUP_MAINTENANCE_MODE !== 'true';
  function launch() {
    if (!enabled || stopping) return;
    const childEnv = {};
    // Keep authentication, mailer, OAuth and unrelated application secrets out
    // of the worker. Only its database and dedicated S3 identity are needed.
    for (const [key, value] of Object.entries(env)) {
      if ((/^BACKUP_/.test(key) && !/^BACKUP_DOWNLOAD_/.test(key)) || ['PATH', 'LANG', 'LC_ALL', 'NODE_ENV', 'TZ', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].includes(key)) childEnv[key] = value;
    }
    childEnv.DOTENV_CONFIG_PATH = '/dev/null';
    childEnv.BACKUP_PROCESS_ROLE = 'worker';
    childEnv.BACKUP_PART_MIB = env.BACKUP_PART_MIB || '5';
    childEnv.BACKUP_UPLOAD_CONCURRENCY = '1';
    const args = ['--max-old-space-size=64', workerFile];
    const command = process.platform === 'win32' ? process.execPath : 'nice';
    const commandArgs = process.platform === 'win32' ? args : ['-n', '15', process.execPath, ...args];
    child = spawnProcess(command, commandArgs, { env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });
    log({ event: 'backup-process-started', pid: child.pid, mode: 'shared', heapMiB: 64 });
    let finished = false;
    const exited = code => {
      if (finished) return; finished = true; child = null;
      if (!stopping) {
        log({ event: 'backup-process-restarting', code: Number.isInteger(code) ? code : 'PROCESS_EXIT' });
        restart = schedule(launch, 15000); restart.unref?.();
      }
    };
    child.once('error', () => exited(null));
    child.once('exit', exited);
  }
  launch();
  return {
    async stop() {
      stopping = true; if (restart) unschedule(restart);
      const current = child;
      if (!current) return;
      await new Promise(resolve => {
        const force = schedule(() => { current.kill('SIGKILL'); resolve(); }, 8000);
        force.unref?.();
        current.once('exit', () => { unschedule(force); resolve(); });
        current.kill('SIGTERM');
      });
    },
  };
}
