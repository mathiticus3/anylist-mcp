import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WRITE_PROFILES, WRITE_SOURCES, writePolicyFile, assertWriteScope, dayInScope, digest } from '../src/profiles/estate-write-policy.js';
test('dedicated write policy binds exact profile, client, account, operation and private file', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'synthetic-write-policy-')), old = process.env.DATA_DIR;
  process.env.DATA_DIR = dir; t.after(() => { if (old === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = old; rmSync(dir, { recursive: true, force: true }); });
  const policy = { schemaVersion: 1, clientId: randomUUID(), userId: randomUUID(), enabled: true,
    revision: 1, upstreamUserId: 'synthetic-user', journalId: randomUUID(), operations: ['shopping.add'], listId: 'a'.repeat(32) };
  const file = writePolicyFile(WRITE_PROFILES.shopping), save = () => writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
  save(); const load = () => assertWriteScope(WRITE_PROFILES.shopping, policy.clientId, policy.userId, WRITE_SOURCES.shopping);
  assert.equal(load().listId, policy.listId);
  assert.throws(() => assertWriteScope(WRITE_PROFILES.meal, policy.clientId, policy.userId, WRITE_SOURCES.shopping));
  assert.throws(() => assertWriteScope(WRITE_PROFILES.shopping, randomUUID(), policy.userId, WRITE_SOURCES.shopping));
  policy.operations = ['shopping.add', 'shopping.add']; save(); assert.throws(load);
  policy.operations = ['shopping.add']; policy.enabled = false; save(); assert.throws(load);
  policy.enabled = true; save(); chmodSync(file, 0o644); assert.throws(load);
  rmSync(file); writeFileSync(file + '.other', JSON.stringify(policy), { mode: 0o600 }); symlinkSync(file + '.other', file); assert.throws(load);
});
test('Denver date bounds are real calendar days across DST, with stable canonical digests', () => {
  const policy = { timeZone: 'America/Denver', maxPastDays: 1, maxFutureDays: 2 };
  const now = new Date('2026-11-01T07:30:00Z');
  assert.equal(dayInScope(policy, '2026-10-31', now), true);
  assert.equal(dayInScope(policy, '2026-11-03', now), true);
  assert.equal(dayInScope(policy, '2026-11-04', now), false);
  assert.throws(() => dayInScope(policy, '2026-02-30', now));
  assert.equal(digest({ b: 1, a: [2, 3] }), digest({ a: [2, 3], b: 1 }));
  assert.notEqual(digest({ a: true }), digest({ a: 1 }));
});
