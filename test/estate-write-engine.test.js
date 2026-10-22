import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeJournal, openJournal } from '../src/profiles/estate-write-journal.js';
import { WriteEngine } from '../src/profiles/estate-write-engine.js';
import { digest } from '../src/profiles/estate-write-policy.js';
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'synthetic-write-engine-'));
  const file = path.join(dir, 'journal.sqlite3'), journalId = randomUUID(); initializeJournal(file, journalId);
  const journal = openJournal(file, journalId); t.after(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  const policy = { clientId: randomUUID(), userId: randomUUID(), journalId, kind: 'shopping', listId: 'a'.repeat(32), operations: ['shopping.add'], policyDigest: 'a'.repeat(64) };
  let enabled = true, calls = 0, exists = false, fail = false, observeFail = false, afterDispatch = () => {};
  const before = { exists: false }, after = { exists: true, id: 'b'.repeat(32), name: 'Fixture' };
  const port = {
    validate: value => value,
    inspect: async () => exists ? after : before,
    prepare: async () => ({ record_id: after.id, before: exists ? after : before, after }),
    dispatch: async () => { calls++; exists = true; afterDispatch(); if (fail) throw Error('private upstream sentinel'); },
    observe: async () => { if (observeFail) throw Error('private readback sentinel'); return exists ? after : before; },
  };
  const authority = () => { if (!enabled) throw Error('POLICY_UNAVAILABLE'); return policy; };
  const engine = new WriteEngine({ authority, journal, port });
  const command = { action: 'apply', operation: 'shopping.add', fields: { name: 'Fixture' }, expected_digest: digest(before), change_id: randomUUID() };
  return { engine, journal, policy, port, command, calls: () => calls, disable: () => { enabled = false; },
    loseAck: () => { fail = true; }, failReadback: () => { observeFail = true; }, revokeDuringDispatch: fn => { afterDispatch = fn; } };
}
test('one acknowledged dispatch plus independent readback; duplicates return durable receipt', async t => {
  const f = fixture(t); const receipt = await f.engine.execute(f.command);
  assert.equal(receipt.outcome, 'CONFIRMED'); assert.equal(receipt.postcondition_observed, true);
  assert.equal((await f.engine.execute(f.command)).outcome, 'CONFIRMED'); assert.equal(f.calls(), 1);
  assert.equal((await f.engine.execute({ action: 'receipt', change_id: f.command.change_id })).outcome, 'CONFIRMED');
});
test('lost ACK remains UNKNOWN even when the postcondition is observed; never redispatch', async t => {
  const f = fixture(t); f.loseAck(); const receipt = await f.engine.execute(f.command);
  assert.equal(receipt.outcome, 'UNKNOWN'); assert.equal(receipt.postcondition_observed, true);
  assert.ok(!JSON.stringify(receipt).includes('private upstream sentinel'));
  assert.equal((await f.engine.execute(f.command)).outcome, 'UNKNOWN');
  assert.equal((await f.engine.execute({ action: 'reconcile', change_id: f.command.change_id })).outcome, 'UNKNOWN');
  assert.equal(f.calls(), 1);
});
test('durable ACK survives failed readback and can be reconciled without a second write', async t => {
  const f = fixture(t); f.failReadback(); assert.equal((await f.engine.execute(f.command)).outcome, 'ACKNOWLEDGED');
  f.port.observe = async () => ({ exists: true, id: 'b'.repeat(32), name: 'Fixture' });
  assert.equal((await f.engine.execute({ action: 'reconcile', change_id: f.command.change_id })).outcome, 'CONFIRMED');
  assert.equal(f.calls(), 1);
});
test('stale precondition is a durable non-effect; changed content cannot reuse its key', async t => {
  const f = fixture(t); f.command.expected_digest = 'c'.repeat(64);
  assert.equal((await f.engine.execute(f.command)).outcome, 'NOT_DISPATCHED'); assert.equal(f.calls(), 0);
  await assert.rejects(f.engine.execute({ ...f.command, fields: { name: 'Changed' } }));
});
test('revoked authority blocks stored receipts and withholds effects after dispatch', async t => {
  const f = fixture(t); f.revokeDuringDispatch(f.disable);
  await assert.rejects(f.engine.execute(f.command)); assert.equal(f.calls(), 1);
  await assert.rejects(f.engine.execute({ action: 'receipt', change_id: f.command.change_id }));
});
test('receipt/reconcile accepts only exact fields and no caller-selected identity', async t => {
  const f = fixture(t);
  await assert.rejects(f.engine.execute({ action: 'receipt', change_id: f.command.change_id, clientId: randomUUID() }));
  await assert.rejects(f.engine.execute({ ...f.command, operation: 'meal.delete' })); assert.equal(f.calls(), 0);
});
