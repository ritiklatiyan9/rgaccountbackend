import test from 'node:test';
import assert from 'node:assert/strict';
import {historyProjectionFields,historySourceSql} from '../src/services/requestHistoryProjection.js';

test('projection parsing handles function commas, FROM in identifiers, nested sources and alias overrides',()=>{
  const columns=new Map(['id','site_id','buyer_name','payment_from','status','secret'].map(name=>[name,{}]));
  const sql="SELECT pp.*,COALESCE(pp.buyer_name,p.buyer_name) AS buyer_name,COALESCE(u.name,u.email) AS requester,pp.payment_from AS entity_secondary,'FROM, text' AS label FROM plot_payments pp JOIN plots p ON p.id=pp.id";
  const fields=historyProjectionFields(sql,columns);assert.ok(!fields.has('name'));assert.ok(!fields.has('email'));assert.ok(fields.has('requester'));
  const expanded=historySourceSql(sql,columns,new Set(['id','site_id','status','buyer_name','payment_from']));
  assert.ok(!expanded.includes('pp.*'));assert.ok(!expanded.includes('pp."buyer_name"'));assert.ok(!expanded.includes('pp."secret"'));
  assert.ok(expanded.includes('pp.payment_from AS entity_secondary'));assert.ok(expanded.endsWith('FROM plot_payments pp JOIN plots p ON p.id=pp.id'));
  const nested="SELECT visible.*,'seek' AS source FROM (SELECT sp.id,u.name AS requested_by_name FROM seek_permissions sp JOIN users u ON u.id=sp.id) visible";
  assert.deepEqual([...historyProjectionFields(nested,columns)].sort(),['id','requested_by_name','source']);
  assert.ok(!historySourceSql(nested,columns).includes('visible."secret"'));
});
