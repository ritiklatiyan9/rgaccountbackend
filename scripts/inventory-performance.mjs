import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? walk(path.join(directory, entry.name))
    : entry.name.endsWith('.js') && !entry.name.includes('.test.') ? [path.join(directory, entry.name)] : []))).flat();
}
const sourceFiles = (await walk(path.join(root, 'src'))).filter(file => !/[\\/](migrations|scripts|checks)[\\/]/.test(file));
const files = await Promise.all(sourceFiles.map(async file => {
  const source = await readFile(file, 'utf8');
  const routes = [...source.matchAll(/router\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g)].map(match => ({
    method: match[1].toUpperCase(), path: match[2], line: source.slice(0, match.index).split('\n').length,
  }));
  return { file: path.relative(root, file), bytes: Buffer.byteLength(source),
    imports: [...source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map(match => match[1]),
    routes, query_call_sites: (source.match(/\.query\s*\(/g) || []).length,
    parallel_groups: (source.match(/Promise\.all(?:Settled)?\s*\(/g) || []).length,
    loop_sites: (source.match(/\bfor\s*\(/g) || []).length,
    limit_mentions: (source.match(/\bLIMIT\b/g) || []).length,
    offset_mentions: (source.match(/\bOFFSET\b/g) || []).length,
    select_all_mentions: (source.match(/SELECT\s+(?:\w+\.)?\*/gi) || []).length,
  };
}));
const index = await readFile(path.join(root, 'src/routes/index.js'), 'utf8');
const routeImports = new Map([...index.matchAll(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g)].map(match => [match[1], match[2]]));
const mounts = [...index.matchAll(/router\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)/g)].map(match => {
  const file = path.posix.normalize('src/routes/' + routeImports.get(match[2]));
  return { prefix: match[1], file, endpoints: files.find(row => row.file === file)?.routes || [] };
});
process.stdout.write(JSON.stringify({ generated_at: new Date().toISOString(),
  caveat: 'Static source inventory. Counts are syntax mentions/call sites, not executed requests or query counts. Wallet re-exports loyalty-vault routes. GraphQL operations are defined separately from Express mounts.',
  totals: { source_files: files.length, route_mounts: mounts.length,
    endpoint_declarations: files.reduce((sum, file) => sum + file.routes.length, 0),
    query_call_sites: files.reduce((sum, file) => sum + file.query_call_sites, 0) },
  mounts, files: files.sort((a, b) => a.file.localeCompare(b.file)),
}, null, 2) + '\n');
