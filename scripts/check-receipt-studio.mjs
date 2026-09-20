import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { RECEIPT_SOURCES, getReceiptRecord } from '../src/controllers/receiptRecord.controller.js';
import { getReceiptDesign } from '../src/services/receiptDesign.service.js';
try {
  const designs = await Promise.all([1,2,5,6,7,8,9,10].map(id => getReceiptDesign(id)));
  designs.forEach(design => assert.deepEqual(design, designs[0]));
  console.log('All 8 sites resolve the same shared OM ASSOCIATES design.');
  for (const [module, source] of Object.entries(RECEIPT_SOURCES)) {
    const { rows } = await pool.query(`SELECT id FROM ${source.table} ORDER BY id DESC LIMIT 1`);
    if (!rows.length) { console.log(`${module}: no saved records`); continue; }
    const req = { params: { module, id: rows[0].id }, user: { role: 'admin' } };
    await new Promise((resolve, reject) => {
      const res = { set() {}, status(code) { this.code = code; return this; }, json(data) {
        if (this.code) return reject(new Error(`${module}: HTTP ${this.code} ${data.message}`));
        try { assert.ok(data.record?.id); assert.ok(data.site?.id); console.log(`${module}: source and site verified`); resolve(); } catch(error) { reject(error); }
      } };
      getReceiptRecord(req, res, reject);
    });
  }
} finally { await pool.end(); }
