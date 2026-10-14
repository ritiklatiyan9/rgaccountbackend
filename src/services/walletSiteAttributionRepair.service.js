import { isDeepStrictEqual } from 'node:util';

// This is deliberately one reviewed repair, not a general ledger editor.
export const WALLET_SITE_ATTRIBUTION_REPAIR = Object.freeze({
  repairKey: 'wallet-site-attribution:9a1efb5d-98e5-4dea-9522-902ff28e650a:site:9:v1',
  transferId: '9a1efb5d-98e5-4dea-9522-902ff28e650a', organizationId: 1,
  siteId: 9, siteName: 'Green Valley Test', actorId: 7,
  fromHolderId: 7, toHolderId: 6, amount: '1504000.00',
  originalEntryIds: ['103', '104'],
  reason: 'Assign the confirmed legacy cash handover to Green Valley Test; preserve the original immutable movements.',
  authorizedInstruction: 'User confirmed assignment of this exact accepted INR 1504000 handover to Green Valley Test, site 9.',
});
const target = WALLET_SITE_ATTRIBUTION_REPAIR;
const fail = message => { throw Object.assign(new Error(message), { code: 'WALLET_SITE_REPAIR_CONFLICT' }); };
const assert = (condition, message) => { if (!condition) fail(message); };
const paise = value => {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  assert(match, 'Unexpected non-monetary amount in the repair snapshot.');
  return (match[1] ? -1n : 1n) * (BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0')));
};
const same = (left, right, message) => assert(isDeepStrictEqual(left, right), message);
const withoutSite = ({ site_id: _site, ...transfer }) => transfer;
const balanceKey = row => `${row.holder_key}:${row.site_id ?? 'unallocated'}`;
const holderKeys = [`user:${target.toHolderId}`, `user:${target.fromHolderId}`].sort();

async function capture(db) {
  const transfer = (await db.query('SELECT * FROM loyalty_vault_transfers WHERE id=$1', [target.transferId])).rows[0];
  const originals = (await db.query('SELECT * FROM loyalty_vault_entries WHERE transfer_id=$1 ORDER BY id', [target.transferId])).rows;
  const corrections = (await db.query("SELECT * FROM loyalty_vault_entries WHERE details->>'repair_key'=$1 ORDER BY id", [target.repairKey])).rows;
  const accounts = (await db.query(`SELECT holder_key,organization_id,balance::text,reserved_balance::text
    FROM loyalty_vault_accounts WHERE organization_id=$1 ORDER BY holder_key`, [target.organizationId])).rows;
  const siteBalances = (await db.query(`SELECT holder_key,site_id,sum(amount)::text AS balance,count(*)::int AS entry_count
    FROM loyalty_vault_entries WHERE organization_id=$1 GROUP BY holder_key,site_id ORDER BY holder_key,site_id NULLS LAST`, [target.organizationId])).rows;
  const globalLedger = (await db.query(`SELECT holder_key,sum(amount)::text AS balance
    FROM loyalty_vault_entries WHERE organization_id=$1 GROUP BY holder_key ORDER BY holder_key`, [target.organizationId])).rows;
  const count = (await db.query('SELECT count(*)::int AS entry_count FROM loyalty_vault_entries WHERE organization_id=$1', [target.organizationId])).rows[0].entry_count;
  return { transfer, originals, corrections, accounts, siteBalances, globalLedger, entryCount: count };
}

function validateTransfer(snapshot) {
  const transfer = snapshot.transfer;
  assert(transfer, 'The exact reviewed transfer was not found.');
  assert(transfer.id === target.transferId && Number(transfer.organization_id) === target.organizationId
    && transfer.from_holder_type === 'user' && Number(transfer.from_holder_id) === target.fromHolderId
    && transfer.to_holder_type === 'user' && Number(transfer.to_holder_id) === target.toHolderId
    && Number(transfer.sender_id) === target.fromHolderId && Number(transfer.recipient_id) === target.toHolderId
    && transfer.status === 'accepted' && paise(transfer.amount) === paise(target.amount),
  'Transfer identity, holders, amount or accepted status differs from the reviewed repair.');
  assert(snapshot.originals.length === 2, 'Expected exactly two original immutable transfer movements.');
  same(snapshot.originals.map(entry => String(entry.id)), target.originalEntryIds, 'Original transfer entry IDs differ from the reviewed evidence.');
  for (const [index, entry] of snapshot.originals.entries()) {
    const sender = index === 0;
    assert(Number(entry.organization_id) === target.organizationId && entry.holder_type === 'user'
      && Number(entry.holder_id) === (sender ? target.fromHolderId : target.toHolderId)
      && entry.holder_key === `user:${sender ? target.fromHolderId : target.toHolderId}`
      && entry.site_id == null && entry.kind === (sender ? 'transfer_out' : 'transfer_in')
      && paise(entry.amount) === (sender ? -paise(target.amount) : paise(target.amount)),
    'An original movement differs from the reviewed null-site handover.');
  }
  for (const key of holderKeys) {
    assert(snapshot.accounts.some(account => account.holder_key === key), `Missing existing holder account ${key}.`);
  }
}

function validateCorrections(snapshot) {
  assert(Number(snapshot.transfer.site_id) === target.siteId, 'Existing repair does not point to Green Valley Test.');
  assert(snapshot.corrections.length === 4, 'Expected exactly four attribution corrections; refusing a partial or conflicting replay.');
  for (const original of snapshot.originals) {
    const rows = snapshot.corrections.filter(entry => String(entry.details?.original_entry_id) === String(original.id));
    assert(rows.length === 2, 'Each original must have one null-site reversal and one site attribution.');
    for (const entry of rows) {
      const reversal = entry.site_id == null;
      assert((reversal || Number(entry.site_id) === target.siteId)
        && entry.kind === (reversal ? 'reversal' : 'adjustment')
        && Number(entry.organization_id) === target.organizationId && entry.holder_key === original.holder_key
        && entry.holder_type === 'user' && Number(entry.holder_id) === Number(original.holder_id)
        && entry.transfer_id == null && entry.source_table == null && entry.source_id == null && entry.cash_flow_entry_id == null
        && Number(entry.actor_id) === target.actorId
        && entry.details?.attributed_transfer_id === target.transferId
        && Number(entry.details?.assigned_site_id) === target.siteId
        && entry.details?.reason === target.reason && entry.details?.authorized_instruction === target.authorizedInstruction
        && paise(entry.amount) === (reversal ? -paise(original.amount) : paise(original.amount)),
      'An existing attribution correction differs from the reviewed repair.');
    }
    assert(rows.filter(entry => entry.site_id == null).length === 1, 'Duplicate reversal in the existing repair.');
  }
  for (const key of holderKeys) {
    const unallocated = snapshot.siteBalances.find(row => row.holder_key === key && row.site_id == null);
    assert(unallocated && paise(unallocated.balance) === 0n, 'A repaired holder still has unallocated cash.');
  }
}

function validateApplied(before, after) {
  validateTransfer(after);
  validateCorrections(after);
  same(withoutSite(before.transfer), withoutSite(after.transfer), 'Repair changed transfer data beyond site_id.');
  same(before.originals, after.originals, 'Repair changed an original immutable movement.');
  same(before.accounts, after.accounts, 'Repair changed global account balances or reservations.');
  same(before.globalLedger, after.globalLedger, 'Repair changed a holder’s global ledger balance.');
  assert(after.entryCount === before.entryCount + 4, 'Repair must append exactly four ledger entries.');
  const expected = new Map(before.siteBalances.map(row => [balanceKey(row), { balance: paise(row.balance), entryCount: row.entry_count }]));
  for (const entry of before.originals) {
    for (const [site, delta] of [[null, -paise(entry.amount)], [target.siteId, paise(entry.amount)]]) {
      const key = `${entry.holder_key}:${site ?? 'unallocated'}`;
      const previous = expected.get(key) || { balance: 0n, entryCount: 0 };
      expected.set(key, { balance: previous.balance + delta, entryCount: previous.entryCount + 1 });
    }
  }
  assert(after.siteBalances.length === expected.size, 'Repair unexpectedly added or removed a site/holder balance.');
  for (const row of after.siteBalances) {
    const expectedRow = expected.get(balanceKey(row));
    assert(expectedRow && paise(row.balance) === expectedRow.balance && row.entry_count === expectedRow.entryCount,
      'Repair changed a site balance outside the exact four attribution postings.');
  }
}

/** Dry-run by default. Applying requires an awaited durable snapshot callback. */
export async function repairWalletTransferSite(database, { apply = false, actorId = target.actorId, beforeSnapshotWriter } = {}) {
  assert(typeof apply === 'boolean', 'apply must be a boolean.');
  assert(Number(actorId) === target.actorId, 'This reviewed repair is authorized under account 7 only.');
  assert(!apply || typeof beforeSnapshotWriter === 'function', 'Applying requires a durable before-snapshot writer.');
  const db = await database.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [target.repairKey]);
    const site = (await db.query('SELECT id,name,organization_id FROM sites WHERE id=$1', [target.siteId])).rows[0];
    assert(site && Number(site.organization_id) === target.organizationId && site.name === target.siteName, 'Site 9 no longer matches Green Valley Test in organization 1.');
    const actor = (await db.query('SELECT id,name,role,organization_id,is_active FROM users WHERE id=$1', [target.actorId])).rows[0];
    assert(actor && actor.is_active === true && ['admin', 'super_admin'].includes(actor.role)
      && Number(actor.organization_id) === target.organizationId, 'Repair actor must be the active organization 1 administrator account 7.');
    await db.query('SELECT id FROM loyalty_vault_transfers WHERE id=$1 FOR UPDATE', [target.transferId]);
    await db.query('SELECT holder_key FROM loyalty_vault_accounts WHERE holder_key=ANY($1::text[]) ORDER BY holder_key FOR UPDATE', [holderKeys]);
    const before = await capture(db);
    validateTransfer(before);
    const checkedAt = (await db.query('SELECT now() AS checked_at')).rows[0].checked_at;
    if (before.corrections.length || before.transfer.site_id != null) {
      validateCorrections(before);
      await db.query('COMMIT');
      return { status: 'already_applied', applied: false, repair: target, actor, site, checkedAt, before };
    }
    for (const original of before.originals) {
      const unallocated = before.siteBalances.find(row => row.holder_key === original.holder_key && row.site_id == null);
      assert(unallocated && paise(unallocated.balance) === paise(original.amount), 'Unexpected additional unallocated holder cash; review the evidence before repairing.');
    }
    const report = { status: apply ? 'ready_to_apply' : 'dry_run', applied: false, repair: target, actor, site, checkedAt, before,
      plannedEntries: before.originals.flatMap(original => [
        { originalEntryId: String(original.id), holderKey: original.holder_key, siteId: null, kind: 'reversal', amountPaise: String(-paise(original.amount)) },
        { originalEntryId: String(original.id), holderKey: original.holder_key, siteId: target.siteId, kind: 'adjustment', amountPaise: String(paise(original.amount)) },
      ]) };
    if (!apply) { await db.query('COMMIT'); return report; }
    // The CLI fsyncs this evidence before this callback resolves. No ledger or
    // transfer mutation has happened yet; a failed writer rolls everything back.
    await beforeSnapshotWriter(report);
    for (const original of before.originals) {
      const details = { repair_key: target.repairKey, original_entry_id: String(original.id), attributed_transfer_id: target.transferId,
        assigned_site_id: target.siteId, reason: target.reason, authorized_instruction: target.authorizedInstruction,
        performed_by: 'system repair on explicit user instruction' };
      await db.query(`SELECT loyalty_vault_apply_delta($1,$2,-$3::numeric,'reversal',$4,NULL,NULL,NULL,NULL,$5,NULL,$6)`,
        [original.holder_key, target.organizationId, original.amount, `Reverse unallocated handover ${target.transferId} for site attribution`, target.actorId, details]);
      await db.query(`SELECT loyalty_vault_apply_delta($1,$2,$3::numeric,'adjustment',$4,NULL,NULL,NULL,$5,$6,NULL,$7)`,
        [original.holder_key, target.organizationId, original.amount, `Attribute handover ${target.transferId} to ${target.siteName}`, target.siteId, target.actorId, details]);
    }
    const updated = await db.query(`UPDATE loyalty_vault_transfers SET site_id=$2 WHERE id=$1 AND organization_id=$3
      AND site_id IS NULL AND status='accepted' AND amount=$4::numeric RETURNING id`,
    [target.transferId, target.siteId, target.organizationId, target.amount]);
    assert(updated.rows.length === 1, 'The target transfer changed while preparing attribution.');
    const after = await capture(db);
    validateApplied(before, after);
    await db.query('COMMIT');
    return { ...report, status: 'applied', applied: true, after };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
