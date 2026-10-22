import Database from 'better-sqlite3';
import { openSync, closeSync, fstatSync, fsyncSync, constants } from 'node:fs';
import path from 'node:path';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function requireValue(condition, code = 'JOURNAL_UNAVAILABLE') {
  if (!condition) throw new Error(code);
}
function encoded(value) {
  const text = JSON.stringify(value);
  requireValue(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  return text;
}
function verifyDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    requireValue(info.isDirectory() && (info.mode & 0o077) === 0 && info.uid === process.getuid());
  } finally { closeSync(fd); }
}
function verifyFile(file) {
  verifyDirectory(path.dirname(file));
  const fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    requireValue(info.isFile() && info.nlink === 1 && (info.mode & 0o077) === 0
      && info.uid === process.getuid());
  } finally { closeSync(fd); }
}
// Explicit administrative bootstrap only; runtime never creates a missing journal.
export function initializeJournal(file, journalId) {
  requireValue(UUID.test(journalId));
  verifyDirectory(path.dirname(file));
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR
    | constants.O_NOFOLLOW, 0o600);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec(`
      CREATE TABLE journal_meta (version INTEGER NOT NULL, journal_id TEXT NOT NULL);
      CREATE TABLE commands (
        client_id TEXT NOT NULL, change_id TEXT NOT NULL, policy_digest TEXT NOT NULL,
        command_hash TEXT NOT NULL, domain TEXT NOT NULL, command_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('PREPARED','UNKNOWN','ACKNOWLEDGED','CONFIRMED','NOT_DISPATCHED')),
        evidence_json TEXT NOT NULL DEFAULT '{}', observation_json TEXT NOT NULL DEFAULT '{}',
        refusal_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(client_id, change_id)
      );
      CREATE TABLE fences (domain TEXT PRIMARY KEY, client_id TEXT NOT NULL, change_id TEXT NOT NULL);
      CREATE TABLE resolutions (client_id TEXT NOT NULL, change_id TEXT NOT NULL, command_hash TEXT NOT NULL,
        approval_reference TEXT NOT NULL, reviewed_outcome TEXT NOT NULL, operator_uid INTEGER NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(client_id, change_id));
      CREATE TRIGGER resolutions_no_update BEFORE UPDATE ON resolutions BEGIN SELECT RAISE(ABORT, 'append-only resolution'); END;
      CREATE TRIGGER resolutions_no_delete BEFORE DELETE ON resolutions BEGIN SELECT RAISE(ABORT, 'append-only resolution'); END;
    `);
    db.prepare('INSERT INTO journal_meta VALUES (1, ?)').run(journalId);
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  const parent = openSync(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function openJournal(file, journalId) {
  verifyFile(file);
  const db = new Database(file, { fileMustExist: true, timeout: 5000 });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    const metadata = db.prepare('SELECT * FROM journal_meta').all();
    requireValue(metadata.length === 1 && metadata[0].version === 1
      && metadata[0].journal_id === journalId && UUID.test(journalId));
    return new Journal(db);
  } catch (error) { db.close(); throw error; }
}
class Journal {
  constructor(db) { this.db = db; }
  close() { this.db.close(); }
  row(clientId, changeId) {
    return this.db.prepare('SELECT * FROM commands WHERE client_id = ? AND change_id = ?').get(clientId, changeId);
  }
  view(row) {
    return { client_id: row.client_id, change_id: row.change_id, policy_digest: row.policy_digest,
      command_hash: row.command_hash, domain: row.domain, command: JSON.parse(row.command_json),
      state: row.state, evidence: JSON.parse(row.evidence_json), observation: JSON.parse(row.observation_json),
      refusal_code: row.refusal_code, created_at: row.created_at, updated_at: row.updated_at,
      administrative_resolution: this.db.prepare('SELECT approval_reference, reviewed_outcome, operator_uid, created_at FROM resolutions WHERE client_id = ? AND change_id = ?').get(row.client_id, row.change_id) ?? null };
  }
  get(clientId, changeId, policyDigest) {
    const row = this.row(clientId, changeId);
    requireValue(row && row.policy_digest === policyDigest, 'RECEIPT_UNAVAILABLE');
    return this.view(row);
  }
  reserve(input) {
    requireValue(UUID.test(input.clientId) && UUID.test(input.changeId) && HASH.test(input.policyDigest)
      && HASH.test(input.commandHash) && typeof input.domain === 'string' && input.domain.length <= 256);
    const command = encoded(input.command);
    return this.db.transaction(() => {
      const existing = this.row(input.clientId, input.changeId);
      if (existing) {
        requireValue(existing.command_hash === input.commandHash
          && existing.policy_digest === input.policyDigest, 'CHANGE_ID_CONFLICT');
        return this.view(existing);
      }
      requireValue(!this.db.prepare('SELECT 1 FROM fences WHERE domain = ?').get(input.domain), 'DOMAIN_BUSY');
      requireValue(this.db.prepare('SELECT COUNT(*) AS count FROM commands').get().count < 10000, 'JOURNAL_FULL');
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO commands
        (client_id, change_id, policy_digest, command_hash, domain, command_json, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?)`)
        .run(input.clientId, input.changeId, input.policyDigest, input.commandHash, input.domain, command, now, now);
      this.db.prepare('INSERT INTO fences VALUES (?, ?, ?)').run(input.domain, input.clientId, input.changeId);
      return this.view(this.row(input.clientId, input.changeId));
    }).immediate();
  }
  transition(clientId, changeId, from, to, column, data, release = false) {
    return this.db.transaction(() => {
      const row = this.row(clientId, changeId);
      requireValue(row && from.includes(row.state), 'INVALID_JOURNAL_TRANSITION');
      const allowedColumns = new Set(['evidence_json', 'observation_json', 'refusal_code']);
      requireValue(allowedColumns.has(column));
      const value = column === 'refusal_code' ? data : encoded(data);
      const changed = this.db.prepare(`UPDATE commands SET state = ?, ${column} = ?, updated_at = ?
        WHERE client_id = ? AND change_id = ? AND state = ?`)
        .run(to, value, new Date().toISOString(), clientId, changeId, row.state);
      requireValue(changed.changes === 1);
      if (release) this.db.prepare('DELETE FROM fences WHERE domain = ? AND client_id = ? AND change_id = ?')
        .run(row.domain, clientId, changeId);
      return this.view(this.row(clientId, changeId));
    }).immediate();
  }
  begin(clientId, changeId, evidence) {
    return this.transition(clientId, changeId, ['PREPARED'], 'UNKNOWN', 'evidence_json', evidence);
  }
  acknowledge(clientId, changeId) {
    return this.transition(clientId, changeId, ['UNKNOWN'], 'ACKNOWLEDGED', 'observation_json', { acknowledged: true });
  }
  confirm(clientId, changeId, observation) {
    requireValue(observation.postcondition_observed === true);
    return this.transition(clientId, changeId, ['ACKNOWLEDGED'], 'CONFIRMED', 'observation_json', observation, true);
  }
  observe(clientId, changeId, observation) {
    const state = this.row(clientId, changeId)?.state;
    requireValue(['UNKNOWN', 'ACKNOWLEDGED'].includes(state));
    return this.transition(clientId, changeId, [state], state, 'observation_json', observation);
  }
  refuse(clientId, changeId, code) {
    requireValue(typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code));
    return this.transition(clientId, changeId, ['PREPARED'], 'NOT_DISPATCHED', 'refusal_code', code, true);
  }
  // Local source administrator only, with service quiescent. Not exposed by MCP.
  releaseAfterOfflineReview(clientId, changeId, { expectedCommandHash, approvalReference, reviewedOutcome }) {
    requireValue(HASH.test(expectedCommandHash) && typeof approvalReference === 'string'
      && approvalReference.length >= 1 && approvalReference.length <= 256
      && !/[\u0000-\u001f\u007f]/.test(approvalReference)
      && ['effect_observed', 'uncertainty_accepted'].includes(reviewedOutcome));
    return this.db.transaction(() => {
      const row = this.row(clientId, changeId);
      requireValue(row && ['UNKNOWN', 'ACKNOWLEDGED'].includes(row.state)
        && row.command_hash === expectedCommandHash, 'RECOVERY_PRECONDITION_CHANGED');
      const existing = this.db.prepare('SELECT * FROM resolutions WHERE client_id = ? AND change_id = ?').get(clientId, changeId);
      if (existing) {
        requireValue(existing.approval_reference === approvalReference && existing.reviewed_outcome === reviewedOutcome, 'RECOVERY_CONFLICT');
        return this.view(row);
      }
      this.db.prepare('INSERT INTO resolutions VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(clientId, changeId, expectedCommandHash, approvalReference, reviewedOutcome, process.getuid(), new Date().toISOString());
      this.db.prepare('DELETE FROM fences WHERE domain = ? AND client_id = ? AND change_id = ?').run(row.domain, clientId, changeId);
      return this.view(row); // Original UNKNOWN/ACK and replay key are retained.
    }).immediate();
  }

}
