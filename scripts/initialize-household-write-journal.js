#!/usr/bin/env node
// Explicit local source-administrator bootstrap only. No credentials or policy changes.
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initializeJournal } from '../src/profiles/estate-write-journal.js';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--kind' || !['shopping', 'meal'].includes(args[1])) {
  console.error('Usage: node scripts/initialize-household-write-journal.js --kind shopping|meal');
  process.exitCode = 2;
} else {
  try {
    const directory = path.join(process.env.DATA_DIR || '/data', 'estate-write-journals');
    mkdirSync(directory, { mode: 0o700, recursive: false });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const file = path.join(process.env.DATA_DIR || '/data', 'estate-write-journals', args[1] + '.sqlite3');
  const journalId = randomUUID();
  try { initializeJournal(file, journalId); console.log(JSON.stringify({ kind: args[1], journal_id: journalId, initialized: true })); }
  catch { console.error('Journal initialization refused. Existing state was not replaced; inspect source custody before proceeding.'); process.exitCode = 1; }
}
