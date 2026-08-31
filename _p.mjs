import 'dotenv/config';
import pkg from 'pg'; const { Pool } = pkg;
const p = new Pool({ host: process.env.DB_HOST, port: +process.env.DB_PORT, database: process.env.DB_NAME,
  user: process.env.DB_USER, password: String(process.env.DB_PASSWORD), ssl: { rejectUnauthorized: false }, max: 2 });
const q = process.argv.slice(2).join(' ');
if (!/^\s*(select|with)\b/i.test(q)) process.exit(1);
console.log(JSON.stringify((await p.query(q)).rows, null, 2)); await p.end();
