import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { up } from '../src/migrations/200_google_calendar_multiple_accounts.js';
import { calendarSyncStatusSql, summarizeCalendarSync } from '../src/services/googleCalendarStatus.service.js';

const script = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/export const /g, 'const ');

test('calendar accounts migrate, connect, sync and disconnect independently', async () => {
  const pg = new PGlite();
  const query = async (sql, params) => {
    if (/SELECT pg_advisory_(?:un)?lock\(/.test(sql)) return { rows: [], rowCount: 1 };
    const result = params?.length ? await pg.query(sql, params) : (await pg.exec(sql)).at(-1);
    return { ...result, rows: result?.rows || [], rowCount: result?.rows?.length || result?.affectedRows || 0 };
  };
  const database = { query, connect: async () => ({ query, release() {} }) };
  try {
    await pg.exec(`
      CREATE TABLE organizations(id int PRIMARY KEY); INSERT INTO organizations VALUES(1),(2);
      CREATE TABLE users(id int PRIMARY KEY); INSERT INTO users VALUES(1),(2);
      CREATE TABLE google_calendar_connections(id bigserial PRIMARY KEY,organization_id int NOT NULL UNIQUE REFERENCES organizations(id),
        google_account_email text NOT NULL,access_token_enc text NOT NULL,refresh_token_enc text NOT NULL,token_expiry timestamptz,
        scope text,connected_by int,status text DEFAULT 'active',notify_attendees boolean DEFAULT true,created_at timestamptz DEFAULT NOW(),updated_at timestamptz DEFAULT NOW());
      INSERT INTO google_calendar_connections(organization_id,google_account_email,access_token_enc,refresh_token_enc)
        VALUES(1,'first@example.test','enc:good1','enc:refresh1'),(2,'outside@example.test','enc:outside','enc:outside-refresh');
      CREATE TABLE google_calendar_event_links(id bigserial PRIMARY KEY,organization_id int,event_type text,source_id bigint,
        google_event_id text,sync_status text DEFAULT 'PENDING',last_synced_at timestamptz,last_attempt_at timestamptz,
        sync_attempt_count int DEFAULT 0,failure_reason text,google_html_link text,remote_updated_at timestamptz,
        created_at timestamptz DEFAULT NOW(),updated_at timestamptz DEFAULT NOW(),UNIQUE(organization_id,event_type,source_id));
      INSERT INTO google_calendar_event_links(organization_id,event_type,source_id,google_event_id) VALUES(1,'COMPLIANCE',10,'legacy-first');
      CREATE TABLE google_drive_connections(id serial PRIMARY KEY,organization_id int,status text,google_account_email text);
      INSERT INTO google_drive_connections(organization_id,status,google_account_email) VALUES(1,'active','first@example.test');
      CREATE TABLE compliance_items(id int PRIMARY KEY,organization_id int,site_id int,title text,current_due_date date,deleted_at timestamptz);
      INSERT INTO compliance_items VALUES(10,1,1,'Filing','2040-10-12',NULL);
      CREATE TABLE compliance_audit_log(organization_id int,site_id int,action text,entity_type text,entity_id bigint,new_value jsonb,reason text);
    `);
    await up(database); await up(database);
    const migrated = (await query('SELECT * FROM google_calendar_event_links')).rows[0];
    assert.equal(Number(migrated.connection_id), 1); assert.equal(migrated.google_event_id, 'legacy-first');
    assert.equal((await query('SELECT notify_attendees FROM google_calendar_connections WHERE id=1')).rows[0].notify_attendees, false);

    const configured = { FRONTEND_URL:'https://app.example.test',GOOGLE_CLIENT_ID:'test',GOOGLE_CLIENT_SECRET:'test',GOOGLE_REDIRECT_URI:'https://api.example.test/callback',CALENDAR_TOKEN_ENC_KEY:'test' };
    const backfills=[],revocations=[],authOptions=[];
    const accounts = { second:{email:'second@example.test',token:'good2'},first:{email:'FIRST@example.test',token:'good1'} };
    const oauth = { generateAuthUrl(options) { authOptions.push(options);return 'https://accounts.google.com/o/oauth2/v2/auth'; },
      async getToken(code) { const account=accounts[code];return {tokens:{access_token:account.token,refresh_token:`refresh-${code}`,id_token:`x.${Buffer.from(JSON.stringify({email:account.email})).toString('base64url')}.x`}}; },
      async revokeToken(token) { revocations.push(token); } };
    const context = { pool:database,asyncHandler:fn=>fn,console:{log(){},error(){}},Buffer,process:{env:configured},
      encrypt:value=>`enc:${value}`,decrypt:value=>value.slice(4),buildOAuthClient:()=>oauth,
      signOAuthState:value=>JSON.stringify(value),verifyOAuthState:()=>({orgId:1,userId:1,origin:'http://127.0.0.1:5174',kind:'calendar'}),
      backfillOrgEvents:async (org,id)=>{backfills.push([org,id]);return {synced:1,failed:0};},handleDriveOAuthCallback:()=>{} };
    vm.createContext(context);
    vm.runInContext(`${script('../src/controllers/googleCalendar.controller.js')}\nthis.handlers={getConnectUrl,oauthCallback,getStatus,disconnect,syncFutureEvents};`,context);
    const invoke = async (name, extra={}) => {
      const result={code:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(v){this.code=v;return this;},json(body){this.body=body;return this;},redirect(url){this.url=url;return this;}};
      await context.handlers[name]({user:{organization_id:1,id:1},query:{},body:{},...extra},result);return result;
    };
    const connected = await invoke('oauthCallback',{query:{code:'second',state:'valid'}});
    assert.equal(connected.url,'http://127.0.0.1:5174/settings/calendar?google=connected');
    const second=(await query("SELECT * FROM google_calendar_connections WHERE google_account_email='second@example.test'")).rows[0];
    assert.equal((await query('SELECT count(*)::int AS n FROM google_calendar_connections WHERE organization_id=1')).rows[0].n,2);
    assert.equal(Number(backfills[0][1]),Number(second.id),'connecting one account backfills only that account');
    await invoke('oauthCallback',{query:{code:'first',state:'valid'}});
    assert.equal((await query('SELECT count(*)::int AS n FROM google_calendar_connections WHERE organization_id=1')).rows[0].n,2,'reconnecting the same email must not duplicate it');
    await assert.rejects(query("INSERT INTO google_calendar_connections(organization_id,google_account_email,access_token_enc,refresh_token_enc) VALUES(1,'SECOND@example.test','x','x')"),error=>error.code==='23505');
    const status=await invoke('getStatus');assert.equal(status.body.connections.length,2);assert.equal(status.headers['Cache-Control'],'no-store');
    assert.doesNotMatch(JSON.stringify(status.body),/access_token|refresh_token|enc:/);
    await invoke('getConnectUrl',{query:{connection_id:second.id}});assert.equal(authOptions.at(-1).prompt,'select_account consent');assert.equal(authOptions.at(-1).login_hint,'second@example.test');
    await invoke('getConnectUrl',{headers:{origin:'http://127.0.0.1:5174'}});assert.equal(JSON.parse(authOptions.at(-1).state).origin,'http://127.0.0.1:5174');
    await invoke('getConnectUrl',{headers:{origin:'https://untrusted.example.test'}});assert.equal(JSON.parse(authOptions.at(-1).state).origin,'https://app.example.test');
    assert.equal((await invoke('getConnectUrl',{query:{connection_id:2}})).code,404);
    assert.equal((await invoke('disconnect',{body:{connection_id:2}})).code,404);
    assert.equal((await invoke('disconnect')).code,400,'an unscoped disconnect must not remove multiple accounts');
    await invoke('syncFutureEvents',{body:{connection_id:second.id}});assert.equal(Number(backfills.at(-1)[1]),Number(second.id));
    assert.equal((await invoke('syncFutureEvents',{body:{connection_id:2}})).code,404);

    const calls=[],remote=new Map([['good1',new Map([['legacy-first',{}]])],['good2',new Map()]]);let expireFirst=false;
    class Auth { setCredentials(credentials){this.token=credentials.access_token;} on(){} }
    const google = {auth:{OAuth2:Auth},calendar:({auth})=>({events:{
      async update(request){calls.push({token:auth.token,operation:'update',request});if(expireFirst&&auth.token==='good1')throw new Error('invalid_grant');assert.ok(remote.get(auth.token).has(request.eventId));remote.get(auth.token).set(request.eventId,request.requestBody);return {data:{id:request.eventId}};},
      async list(request){calls.push({token:auth.token,operation:'list',request});return {data:{items:[]}};},
      async insert(request){calls.push({token:auth.token,operation:'insert',request});const id=`${auth.token}-${remote.get(auth.token).size+1}`;remote.get(auth.token).set(id,request.requestBody);return {data:{id}};},
      async delete(request){calls.push({token:auth.token,operation:'delete',request});assert.ok(remote.get(auth.token).has(request.eventId));remote.get(auth.token).delete(request.eventId);}
    }})};
    const syncContext={pool:database,google,process:{env:configured},console:{log(){},error(){}},encrypt:context.encrypt,decrypt:context.decrypt,
      complianceEventInstant:()=>null,DEFAULT_TIME_ZONE:'Asia/Kolkata',isValidTimeZone:()=>true,
      getEventPreferences:async()=>({calendar_enabled:true,timezone:'Asia/Kolkata'})};
    vm.createContext(syncContext);
    vm.runInContext(`${script('../src/services/googleCalendarSync.service.js')}\nthis.sync=syncComplianceEvent;this.body=buildEventBody;`,syncContext);
    const result=await syncContext.sync(1,'COMPLIANCE',10);assert.equal(result.status,'SYNCED');assert.equal(result.accounts.length,2);
    let links=(await query("SELECT * FROM google_calendar_event_links WHERE organization_id=1 ORDER BY connection_id")).rows;
    assert.equal(links.length,2);assert.equal(links[0].google_event_id,'legacy-first');assert.notEqual(links[0].google_event_id,links[1].google_event_id);
    await syncContext.sync(1,'COMPLIANCE',10);
    assert.equal(calls.filter(call=>call.operation==='insert').length,1,'repeat sync updates each account without duplicate events');
    for(const call of calls.filter(call=>['update','insert','delete'].includes(call.operation))){assert.equal(call.request.sendUpdates,'none');if(call.request.requestBody)assert.equal(call.request.requestBody.attendees.length,0);}
    assert.equal(syncContext.body('COMPLIANCE',{title:'Filing',current_due_date:'2040-10-12'},['team@example.test']).attendees.length,0);
    expireFirst=true;const partial=await syncContext.sync(1,'COMPLIANCE',10);assert.equal(partial.status,'FAILED');assert.equal(partial.accounts[1].status,'SYNCED');
    assert.equal((await query('SELECT status FROM google_calendar_connections WHERE id=1')).rows[0].status,'reauthorization_required');
    assert.equal((await query('SELECT status FROM google_calendar_connections WHERE id=$1',[second.id])).rows[0].status,'active');
    assert.equal((await query(`SELECT ${calendarSyncStatusSql('s','COMPLIANCE')} AS status FROM compliance_items s WHERE id=10`)).rows[0].status,'FAILED');
    assert.equal((await syncContext.sync(1,'COMPLIANCE',10,2)).status,'DISCONNECTED','another organization account must never sync');
    await invoke('disconnect',{body:{connection_id:1}});assert.equal(revocations.length,0,'disconnect must preserve a shared Drive grant');
    links=(await query('SELECT * FROM google_calendar_event_links ORDER BY connection_id')).rows;
    assert.equal(links[0].sync_status,'DISCONNECTED');assert.equal(links[0].google_event_id,'legacy-first');assert.equal(links[1].sync_status,'SYNCED');
    assert.equal((await invoke('getStatus')).body.connections.length,1);
    await invoke('oauthCallback',{query:{code:'first',state:'valid'}});expireFirst=false;
    await syncContext.sync(1,'COMPLIANCE',10,1);
    assert.equal((await query('SELECT google_event_id FROM google_calendar_event_links WHERE connection_id=1')).rows[0].google_event_id,'legacy-first');
    await query('UPDATE compliance_items SET deleted_at=NOW() WHERE id=10');
    const deleted=await syncContext.sync(1,'COMPLIANCE',10);assert.equal(deleted.status,'DELETED');assert.equal(calls.filter(call=>call.operation==='delete').length,2);
    assert.equal((await query('SELECT count(*)::int AS n FROM google_calendar_event_links')).rows[0].n,0);
  } finally {await pg.close();}
});

test('combined calendar status reports missing or failed accounts accurately',()=>{
  assert.equal(summarizeCalendarSync([]),'DISCONNECTED');
  assert.equal(summarizeCalendarSync([{sync_status:'SYNCED'},{sync_status:null}]),'PENDING');
  assert.equal(summarizeCalendarSync([{sync_status:'SYNCED'},{sync_status:'FAILED'}]),'FAILED');
  assert.equal(summarizeCalendarSync([{sync_status:'SYNCED'},{connection_status:'reauthorization_required'}]),'FAILED');
  assert.equal(summarizeCalendarSync([{sync_status:'SYNCED'},{sync_status:'SYNCED'}]),'SYNCED');
});
