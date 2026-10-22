import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WRITE_CONTRACT, WRITE_PROFILES, WRITE_SOURCES, writeKind, assertWriteScope } from './estate-write-policy.js';
import { openJournal } from './estate-write-journal.js';
import { WriteEngine } from './estate-write-engine.js';
import { WritePort } from './estate-write-port.js';
import { withClientLock } from '../stable/errors.js';

export function journalFile(kind) {
  if (!['shopping', 'meal'].includes(kind)) throw Error('INVALID_WRITE_KIND');
  return path.join(process.env.DATA_DIR || '/data', 'estate-write-journals', kind + '.sqlite3');
}
export function registerHouseholdWrites(server, getClient, { profile, actorSource, clientId, userId, currentAuthorization }) {
  const kind = writeKind(profile);
  server.registerTool(kind === 'shopping' ? 'shopping_write' : 'meal_plan_write', {
    title: kind === 'shopping' ? 'Bounded Shopping Changes' : 'Bounded Meal Plan Changes',
    description: 'Dedicated source policy and durable command journal. Inspect before apply with exact expected_digest and UUID change_id. '
      + 'Receipt/reconcile never redispatch. CONFIRMED requires acknowledgement plus independent readback; UNKNOWN may have written and blocks its domain until administrative resolution. '
      + 'No atomic upstream CAS or exactly-once claim. No bulk operations, arbitrary list, recipe mutation or automatic undo.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: { action: z.enum(['inspect', 'apply', 'receipt', 'reconcile']), operation: z.string().optional(),
      record_id: z.string().optional(), fields: z.record(z.unknown()).optional(), expected_digest: z.string().optional(), change_id: z.string().optional() },
  }, async (input, extra) => {
    const authority = () => {
      // The MCP server outlives an HTTP request. Never capture its initialize
      // bearer or rely on admission that preceded asynchronous reads/queues.
      if (typeof currentAuthorization !== 'function') throw Error('CURRENT_AUTHORITY_REQUIRED');
      currentAuthorization(extra, { profile, actorSource, clientId, userId });
      return assertWriteScope(profile, clientId, userId, actorSource);
    };
    let journal, engine;
    try {
      const policy = authority();
      journal = openJournal(journalFile(kind), policy.journalId);
      const execute = async client => {
        engine = new WriteEngine({ authority, journal, port: client ? new WritePort(client) : null });
        const value = await engine.execute(input);
        const current = authority();
        if (current.policyDigest !== policy.policyDigest) throw Error('POLICY_CHANGED');
        const body = { ...value, provider: { contract: WRITE_CONTRACT, profile, source: WRITE_SOURCES[kind],
          client_id: clientId, user_id: userId, upstream_user_id: current.upstreamUserId,
          policy_digest: current.policyDigest, journal_id: current.journalId, readOnly: false, mutationsEnabled: true } };
        const text = JSON.stringify(body);
        if (Buffer.byteLength(text) > 512 * 1024) throw Error('RESPONSE_LIMIT');
        return { content: [{ type: 'text', text }], structuredContent: body };
      };
      // A historical receipt needs current source authorization, not a working
      // upstream account connection. It must remain available during an outage.
      if (input?.action === 'receipt') return await execute(null);
      const client = await getClient();
      return await withClientLock(client, () => execute(client));
    } catch (error) {
      const code = error?.name === 'ZodError' ? 'INVALID_INPUT'
        : /^[A-Z_]{1,80}$/.test(error?.code || '') ? error.code : 'WRITE_REQUEST_UNAVAILABLE';
      const body = { ok: false, contract: WRITE_CONTRACT, request_id: randomUUID(),
        error: { code, message: 'The dedicated write request is unavailable; inspect policy and existing receipts before any new intent.' },
        outcome: engine?.mayHaveDispatched ? 'UNKNOWN' : 'REQUEST_REFUSED',
        command_outcome_known: false, automatic_redispatch: false };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
    } finally { if (journal) journal.close(); }
  });
}
