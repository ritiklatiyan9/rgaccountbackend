import { writeFile } from 'node:fs/promises';
import pool from '../src/config/db.js';
import { repairSunnyWallet } from '../src/services/sunnyWalletRepair.service.js';

const apply=process.argv.includes('--apply');
const index=process.argv.indexOf('--output');
const output=index>=0?process.argv[index+1]:null;
try {
  if(apply&&!output)throw new Error('--apply requires --output for the durable before-snapshot.');
  const result=await repairSunnyWallet(pool,{apply,
    writeSnapshot:output?report=>writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'}):undefined});
  if(output)await writeFile(`${output}.result.json`,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({applied:result.applied,replayed:result.replayed,balance:result.balance,site_id:result.site_id,
    removed_entry_id:result.removed_entry_id,negative_debits_blocked:result.negative_debits_blocked,
    snapshot:output},null,2));
} catch(error) {console.error(JSON.stringify({code:error.code,message:error.message}));process.exitCode=1;}
finally {await pool.end();}
