import test from 'node:test';
import assert from 'node:assert/strict';
import { decorateRegistryStage } from '../src/utils/registryStage.js';
import { registryDeedScopeSql } from '../src/utils/registryDocuments.js';

const complete = { customer_name: 'Buyer', registry_date: '2026-01-01', size_sqyard: 100, circle_rate: 12000, farmer_name: 'Seller', registry_payment: 100000 };

test('handover records cannot imply a deed is currently uploaded', () => {
  const result = decorateRegistryStage({ ...complete, registry_doc_count: 0, handover_count: 1 });
  assert.equal(result.stage, 'yellow');
  assert.equal(result.deed_uploaded, false);
  assert.equal(result.handed_over, false);
  assert.equal(decorateRegistryStage({ registry_doc_count: 0, handover_count: 1 }).stage, 'red');
  assert.equal(decorateRegistryStage({ ...complete, registry_doc_count: 1, handover_count: 0 }).stage, 'blue');
  assert.equal(decorateRegistryStage({ ...complete, registry_doc_count: 1, handover_count: 1 }).stage, 'green');
});

test('deed scope excludes NOC, empty files, DMS and documents owned by a different plot', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE documents(id int, plot_id int, kyc_case_id int, category text, uploaded_source text, file_path text);
      CREATE TABLE bookings(id int, plot_id int); CREATE TABLE kyc_cases(id int, booking_id int);
      INSERT INTO bookings VALUES (1,22); INSERT INTO kyc_cases VALUES (1,1);
      INSERT INTO documents VALUES
        (1,22,NULL,'REGISTRY','ACCOUNT','deed.pdf'),
        (2,22,NULL,'NOC','PLOT_REGISTRY','noc.pdf'),
        (3,22,NULL,'REGISTRY','ACCOUNT',' '),
        (4,22,NULL,'REGISTRY',' dms ','deed.pdf'),
        (5,99,1,'REGISTRY','BOOKING','other-plot.pdf'),
        (6,NULL,1,' registry ','BOOKING','legacy-deed.pdf');`);
    const deeds = async () => (await db.query(`SELECT d.id FROM documents d WHERE ${registryDeedScopeSql('$1')} ORDER BY d.id`, [22])).rows.map(row => row.id);
    assert.deepEqual(await deeds(), [1, 6]);
    await db.query('DELETE FROM documents WHERE id IN (1,6)');
    assert.deepEqual(await deeds(), []);
  } finally { await db.close(); }
});
