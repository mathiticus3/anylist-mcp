#!/usr/bin/env node
// Source administrator recovery only. Stop the source service and inspect the
// actual AnyList state before invoking. No network call or business effect.
import { openJournal } from '../src/profiles/estate-write-journal.js';
import { journalFile } from '../src/profiles/estate-household-writes.js';
const args = process.argv.slice(2), values = {};
const names = new Set(['kind','journal-id','client-id','change-id','expected-command-hash','approval-reference','reviewed-outcome']);
let offline = false, valid = true;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--offline-recovery') { if (offline) valid = false; offline = true; continue; }
  const key = args[index].replace(/^--/, '');
  if (!args[index].startsWith('--') || !names.has(key) || values[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) { valid = false; break; }
  values[key] = args[++index];
}
let journal;
try {
  if (!offline || !valid || Object.keys(values).length !== names.size || !['shopping','meal'].includes(values.kind)) throw Error();
  journal = openJournal(journalFile(values.kind), values['journal-id']);
  const row = journal.releaseAfterOfflineReview(values['client-id'], values['change-id'], {
    expectedCommandHash: values['expected-command-hash'], approvalReference: values['approval-reference'], reviewedOutcome: values['reviewed-outcome'] });
  console.log(JSON.stringify({ change_id: row.change_id, outcome: row.state, fence_released: true,
    replay_preserved: true, administrative_resolution: row.administrative_resolution }));
} catch {
  console.error('Offline recovery refused. Stop the source service, inspect AnyList, and provide the exact journal, command hash and owner approval reference. No automatic retry is permitted.');
  process.exitCode = 1;
} finally { if (journal) journal.close(); }
