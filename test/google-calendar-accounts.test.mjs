import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { up } from '../src/migrations/200_google_calendar_multiple_accounts.js';
import { calendarSyncStatusSql, summarizeCalendarSync } from '../src/services/googleCalendarStatus.service.js';
import { calendarSyncError } from '../src/services/googleCalendarError.service.js';

const script = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/export const /g, 'const ');

test('calendar accounts migrate, connect, sync and disconnect independently', async () => {
  const pg = new PGlite();
  const query = async (sql, params) => {
    if (/SELECT pg_advisory_(?:un)?(?:xact_)?lock\(/.test(sql) || ['BEGIN','ROLLBACK'].includes(sql) || sql.startsWith('SET LOCAL lock_timeout')) return { rows: [], rowCount: 1 };
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
      CREATE TABLE legal_cases(id int,organization_id int,next_hearing_date timestamptz,deleted_at timestamptz);
      CREATE TABLE legal_notices(id int,organization_id int,reply_due_date date,deleted_at timestamptz);
      CREATE TABLE compliance_inspections(id int,organization_id int,scheduled_at timestamptz,deleted_at timestamptz);
      CREATE TABLE compliance_licences(id int,organization_id int,expiry_date date,deleted_at timestamptz);
      CREATE TABLE event_reminder_preferences(organization_id int,event_type text,source_id bigint,calendar_enabled boolean);
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
      backfillOrgEvents:async (org,id)=>{backfills.push([org,id]);return {synced:1,failed:0};},handleDriveOAuthCallback:()=>{}, calendarSyncError };
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
    assert.equal(status.body.connections[1].pending,1,'a future ERP date with no Google mapping must count as pending');
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
      async get(request){if(expireFirst&&auth.token==='good1')throw new Error('invalid_grant');assert.ok(remote.get(auth.token).has(request.eventId));return {data:remote.get(auth.token).get(request.eventId)};},
      async update(request){calls.push({token:auth.token,operation:'update',request});if(expireFirst&&auth.token==='good1')throw new Error('invalid_grant');assert.ok(remote.get(auth.token).has(request.eventId));remote.get(auth.token).set(request.eventId,request.requestBody);return {data:{id:request.eventId}};},
      async list(request){calls.push({token:auth.token,operation:'list',request});return {data:{items:[...remote.get(auth.token)].map(([id,body])=>({id,...body})).filter(item=>request.privateExtendedProperty ? `erpEventKey=${item.extendedProperties?.private?.erpEventKey}`===request.privateExtendedProperty : item.summary===request.q)}};},
      async insert(request){calls.push({token:auth.token,operation:'insert',request});const id=`${auth.token}-${remote.get(auth.token).size+1}`;remote.get(auth.token).set(id,request.requestBody);return {data:{id}};},
      async delete(request){calls.push({token:auth.token,operation:'delete',request});assert.ok(remote.get(auth.token).has(request.eventId));remote.get(auth.token).delete(request.eventId);}
    }})};
    const syncContext={pool:database,google,process:{env:configured},console:{log(){},error(){}},encrypt:context.encrypt,decrypt:context.decrypt,
      complianceEventInstant:()=>null,DEFAULT_TIME_ZONE:'Asia/Kolkata',isValidTimeZone:()=>true,
      getEventPreferences:async()=>({calendar_enabled:true,timezone:'Asia/Kolkata'}), calendarSyncError };
    vm.createContext(syncContext);
    vm.runInContext(`${script('../src/services/googleCalendarSync.service.js')}\nthis.sync=syncComplianceEvent;this.body=buildEventBody;`,syncContext);
    const result=await syncContext.sync(1,'COMPLIANCE',10);assert.equal(result.status,'SYNCED');assert.equal(result.accounts.length,2);
    let links=(await query("SELECT * FROM google_calendar_event_links WHERE organization_id=1 ORDER BY connection_id")).rows;
    assert.equal(links.length,2);assert.equal(links[0].google_event_id,'legacy-first');assert.notEqual(links[0].google_event_id,links[1].google_event_id);
    await syncContext.sync(1,'COMPLIANCE',10);
    assert.equal(calls.filter(call=>call.operation==='insert').length,1,'repeat sync updates each account without duplicate events');
    for(const call of calls.filter(call=>['update','insert','delete'].includes(call.operation))){assert.equal(call.request.sendUpdates,'none');if(call.request.requestBody)assert.equal(call.request.requestBody.attendees.length,0);}
    assert.equal(syncContext.body('COMPLIANCE',{title:'Filing',current_due_date:'2040-10-12'},['team@example.test']).attendees.length,0);
    const legacyBody = syncContext.body('COMPLIANCE', { title: 'Filing', current_due_date: '2040-10-12' });
    remote.get('good1').set('personal-event', { ...legacyBody, description: 'Personal appointment', created: '2025-08-18T13:36:18Z' });
    remote.get('good1').set('legacy-a', { ...legacyBody, created: '2026-08-18T13:36:18Z' });
    remote.get('good1').set('legacy-b', { ...legacyBody, created: '2026-08-18T13:37:17Z' });
    await query(`INSERT INTO compliance_items VALUES(12,1,1,'Filing','2040-10-12',NULL),(13,1,1,'Filing','2040-10-12',NULL)`);
    await syncContext.sync(1, 'COMPLIANCE', 12, 1);
    await syncContext.sync(1, 'COMPLIANCE', 13, 1);
    const duplicateLinks = (await query('SELECT source_id,google_event_id FROM google_calendar_event_links WHERE connection_id=1 ORDER BY source_id')).rows;
    assert.deepEqual(duplicateLinks.map(link => link.google_event_id), ['legacy-first', 'legacy-a', 'legacy-b'], 'identical ERP events claim distinct existing legacy entries without inserting duplicates');
    assert.equal(calls.filter(call=>call.operation==='insert').length,1);
    assert.equal(remote.get('good1').get('personal-event').description, 'Personal appointment', 'unrelated personal events with the same title and date must remain untouched');
    await query(`UPDATE google_calendar_event_links SET google_event_id='legacy-first' WHERE connection_id=1 AND source_id=13`);
    await syncContext.sync(1, 'COMPLIANCE', 13, 1);
    assert.equal((await query('SELECT google_event_id FROM google_calendar_event_links WHERE connection_id=1 AND source_id=13')).rows[0].google_event_id, 'legacy-b', 'an existing shared mapping recovers its own keyed event');
    assert.equal(remote.get('good1').get('legacy-first').extendedProperties.private.erpEventKey, '1:COMPLIANCE:10', 'repair must not overwrite another record’s event');
    await query(`INSERT INTO compliance_items VALUES(14,1,1,'Removed filing','2040-10-12',NOW());
      INSERT INTO google_calendar_event_links(organization_id,connection_id,event_type,source_id,google_event_id)
      VALUES(1,1,'COMPLIANCE',14,'legacy-first')`);
    await syncContext.sync(1, 'COMPLIANCE', 14, 1);
    assert.equal(remote.get('good1').has('legacy-first'), true, 'deleting a record with a historical shared mapping must retain the other record’s event');
    await query('UPDATE compliance_items SET deleted_at=NOW() WHERE id IN (12,13)');
    await syncContext.sync(1, 'COMPLIANCE', 12, 1); await syncContext.sync(1, 'COMPLIANCE', 13, 1);
    expireFirst=true;const partial=await syncContext.sync(1,'COMPLIANCE',10);assert.equal(partial.status,'FAILED');assert.equal(partial.accounts[1].status,'SYNCED');
    assert.equal((await query('SELECT status FROM google_calendar_connections WHERE id=1')).rows[0].status,'reauthorization_required');
    assert.equal((await query('SELECT status FROM google_calendar_connections WHERE id=$1',[second.id])).rows[0].status,'active');
    const failedStatus = await invoke('getStatus');
    assert.equal(failedStatus.body.connections[0].failed, 1);
    assert.equal(failedStatus.body.connections[0].sync_error.code, 'RECONNECT_REQUIRED');
    assert.equal(failedStatus.body.connections[1].synced, 1);
    assert.equal(failedStatus.body.connections[1].sync_error, null);
    assert.doesNotMatch(JSON.stringify(failedStatus.body), /access_token|refresh_token|enc:/);
    await query(`INSERT INTO compliance_items VALUES(11,1,1,'Old filing','2000-01-01',NULL);
      INSERT INTO google_calendar_event_links(organization_id,connection_id,event_type,source_id,sync_status,failure_reason)
      VALUES(1,1,'COMPLIANCE',11,'FAILED','Old provider failure')`);
    assert.equal((await invoke('getStatus')).body.connections[0].failed, 1, 'historical failures must not block the current calendar status');
    await query('DELETE FROM google_calendar_event_links WHERE source_id=11');
    await query(`UPDATE google_calendar_event_links SET sync_status='FAILED',failure_reason=$1 WHERE connection_id=$2`, ['Google Calendar API has not been used in project 652880497016 before or it is disabled.', second.id]);
    const disabledStatus = await invoke('getStatus');
    assert.equal(disabledStatus.body.connections[1].sync_error.code, 'API_DISABLED');
    assert.equal(disabledStatus.body.connections[1].sync_error.setup_url, 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=652880497016');
    await syncContext.sync(1, 'COMPLIANCE', 10, second.id);
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
    const deleted=await syncContext.sync(1,'COMPLIANCE',10);assert.equal(deleted.status,'DELETED');assert.equal(calls.filter(call=>call.operation==='delete').length,4);
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

test('failed calendar advisory-lock acquisition returns its checked-out client', async () => {
  const failure = Object.assign(new Error('lock timed out'), { code: '55P03' });
  let releases = 0, calendarCalls = 0;
  const database = { query: async () => ({ rows: [] }), connect: async () => ({
    async query(sql) {
      if (sql.includes('pg_advisory_xact_lock')) throw failure;
      return { rows: [] };
    },
    release() { releases += 1; },
  }) };
  const context = { pool: database, google: { calendar() { calendarCalls += 1; } },
    process: { env: {} }, console: { log() {}, error() {} },
    DEFAULT_TIME_ZONE: 'Asia/Kolkata' };
  vm.createContext(context);
  vm.runInContext(`${script('../src/services/googleCalendarSync.service.js')}\nthis.run=syncConnectionEvent;`, context);
  await assert.rejects(context.run(1, 'COMPLIANCE', 10, 1), error => error === failure);
  assert.equal(releases, 1); assert.equal(calendarCalls, 0);
});

test('calendar locks remain inside a transaction and release before the client is reused', async () => {
  let transaction = false, locked = false, releases = 0;
  const context = { pool: { query: async () => ({ rows: [] }), connect: async () => ({
    async query(sql) {
      if (sql === 'BEGIN') { assert.equal(transaction, false); transaction = true; }
      else if (sql.includes('pg_advisory_xact_lock')) { assert.equal(transaction, true); locked = true; }
      else if (sql === 'ROLLBACK') { transaction = false; locked = false; }
      else if (!sql.startsWith('SET LOCAL lock_timeout')) throw new Error(`Unexpected lock statement: ${sql}`);
      return { rows: [] };
    },
    release(error) { assert.equal(error, undefined); assert.equal(transaction, false); assert.equal(locked, false); releases++; },
  }) }, google: {}, process: { env: {} }, console: { log() {}, error() {} }, DEFAULT_TIME_ZONE: 'Asia/Kolkata' };
  vm.createContext(context);
  vm.runInContext(`${script('../src/services/googleCalendarSync.service.js')}\nthis.run=syncConnectionEvent;`, context);
  for (const sourceId of [10, 11]) assert.equal((await context.run(1, 'COMPLIANCE', sourceId, 1)).status, 'DISCONNECTED');
  assert.equal(releases, 2);
});

test('a failed lock rollback discards the client instead of returning it to the pool', async () => {
  const cleanupFailure = new Error('Connection lost during rollback');
  let discarded;
  const context = { pool: { query: async () => ({ rows: [] }), connect: async () => ({
    async query(sql) { if (sql === 'ROLLBACK') throw cleanupFailure; return { rows: [] }; },
    release(error) { discarded = error; },
  }) }, google: {}, process: { env: {} }, console: { log() {}, error() {} }, DEFAULT_TIME_ZONE: 'Asia/Kolkata' };
  vm.createContext(context);
  vm.runInContext(`${script('../src/services/googleCalendarSync.service.js')}\nthis.run=syncConnectionEvent;`, context);
  await context.run(1, 'COMPLIANCE', 10, 1);
  assert.equal(discarded, cleanupFailure);
});
