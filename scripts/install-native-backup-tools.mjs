import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Only the official, checksum-pinned PostgreSQL source is built. This adds no
// database server or daemon to the web service, only pg_dump/libpq/pg_restore.
const version = '18.4';
const checksum = '81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094';
const prefix = path.resolve('node_modules', '.cache', `dg-postgresql-${version}`);
const execute = promisify(execFile);
async function usable(binary) {
  try {
    const { stdout } = await execute(binary, ['--version'], { timeout: 10000 });
    return /\(PostgreSQL\) (1[7-9]|[2-9]\d)\./.test(stdout);
  } catch { return false; }
}

if (process.env.BACKUP_WORKER_MODE === 'shared') {
  const dump = path.join(prefix, 'bin', 'pg_dump'), restore = path.join(prefix, 'bin', 'pg_restore');
  if (await usable(dump) && await usable(restore)) console.log('[backup-tools] Cached native tools ready.');
  else {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-backup-tools-'));
    const log = await fs.open(path.join(directory, 'build.log'), 'w', 0o600);
    async function run(command, args) {
      await new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: directory, shell: false, stdio: ['ignore', log.fd, log.fd] });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Native backup tools build failed (${command}, ${code}). Build log: ${path.join(directory, 'build.log')}`)));
      });
    }
    try {
      console.log(`[backup-tools] Installing PostgreSQL ${version} client tools on existing compute.`);
      const response = await fetch(`https://ftp.postgresql.org/pub/source/v${version}/postgresql-${version}.tar.bz2`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`PostgreSQL source download failed (${response.status}).`);
      const hash = createHash('sha256'); let bytes = 0;
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > 64 * 1024 ** 2) return done(new Error('Unexpected PostgreSQL source size.'));
        hash.update(chunk); done(null, chunk);
      } }), createWriteStream(path.join(directory, 'source.tar.bz2'), { mode: 0o600 }));
      if (hash.digest('hex') !== checksum) throw new Error('PostgreSQL source checksum failed.');
      await run('tar', ['-xjf', 'source.tar.bz2', '--strip-components=1']);
      await run('./configure', [`--prefix=${prefix}`, '--without-icu', '--without-readline', '--with-ssl=openssl', '--with-zlib']);
      // A subdirectory build can otherwise compile pg_dump before PostgreSQL's
      // generated catalog headers are ready, especially with parallel make.
      await run('make', ['-C', 'src/backend', 'generated-headers']);
      await run('make', ['-j2', '-C', 'src/bin/pg_dump']);
      await run('make', ['-C', 'src/interfaces/libpq', 'install']);
      await run('make', ['-C', 'src/bin/pg_dump', 'install']);
      if (!await usable(dump) || !await usable(restore)) throw new Error('Installed PostgreSQL tools did not pass the version check.');
      console.log('[backup-tools] Native dump and restore tools ready.');
    } catch (error) {
      // Compiler errors contain no application environment/credentials.
      const output = await fs.readFile(path.join(directory, 'build.log'), 'utf8').catch(() => '');
      console.error(output.slice(-6000)); throw error;
    } finally { await log.close(); await fs.rm(directory, { recursive: true, force: true }); }
  }
}
