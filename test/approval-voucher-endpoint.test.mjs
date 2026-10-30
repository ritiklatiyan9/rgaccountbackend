import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';

test('single voucher lookup enforces site, organisation and assignment or module access before signing',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE TABLE sites(id integer PRIMARY KEY,organization_id integer);
    CREATE TABLE user_sites(user_id integer,site_id integer);
    CREATE TABLE user_approval_modules(user_id integer,module text);
    CREATE TABLE expenses(id integer PRIMARY KEY,site_id integer,assigned_admin_id integer,voucher_url text);
    INSERT INTO sites VALUES(1,1),(2,1),(3,2);
    INSERT INTO user_sites VALUES(7,1),(7,3);
    INSERT INTO expenses VALUES(1,1,7,'https://files.test/vouchers/one.jpg'),
      (2,1,8,'https://files.test/vouchers/two.jpg'),(3,2,7,'https://files.test/vouchers/three.jpg'),
      (4,3,7,'https://files.test/vouchers/four.jpg');`);
  let signed=0;const queries=[];
  const code=readFileSync(new URL('../src/controllers/approval.controller.js',import.meta.url),'utf8')
    .replace(/^import[\s\S]*?;\n/gm,'').replace(/export const /g,'const ');
  const context={asyncHandler:fn=>fn,pool:{query(sql,args){queries.push(sql);return db.query(sql,args);}},signExpenseDocumentUrl:async url=>{signed++;return `${url}?fresh=1`;}};
  vm.createContext(context);vm.runInContext(`${code}\nthis.get=getApprovalVoucher;`,context);
  const invoke=async(id,site_id=1,extra={})=>{
    let status=200,body;
    await context.get({params:{id},query:{source:'expense',site_id},user:{id:7,role:'sub_admin',organization_id:1},assignedApprovalsOnly:true,...extra},
      {status(value){status=value;return this;},json(value){body=value;return this;},set(){return this;}});
    return {status,body};
  };
  assert.equal((await invoke(1)).body.url,'https://files.test/vouchers/one.jpg?fresh=1');
  assert.equal(signed,1);
  assert.ok(queries.every(sql=>!sql.includes('ORDER BY')&&!sql.includes('UNION')),'click never builds the full queue');
  for(const [id,site,status] of [[2,1,403],[3,2,403],[4,3,404],[1,2,404]])assert.equal((await invoke(id,site)).status,status);
  assert.equal(signed,1,'denied records never reach the signer');
  await db.query("INSERT INTO user_approval_modules VALUES(7,'expense')");
  assert.equal((await invoke(2,1,{assignedApprovalsOnly:false})).status,200);
  assert.equal((await invoke(1,1,{query:{source:'__proto__',site_id:1}})).status,400);
  assert.equal((await invoke(0)).status,400);
});
