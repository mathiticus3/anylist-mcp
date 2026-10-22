import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, WRITE_CONTRACT } from './estate-write-policy.js';
import { CapabilityError } from '../stable/errors.js';

const lookup = z.object({ action: z.enum(['receipt', 'reconcile']), change_id: z.string().uuid() }).strict();
const inspect = z.object({ action: z.literal('inspect'), operation: z.string(), record_id: z.string().optional() }).strict();
const apply = z.object({ action: z.literal('apply'), operation: z.string(), record_id: z.string().optional(),
  fields: z.record(z.unknown()), expected_digest: z.string().regex(/^[a-f0-9]{64}$/), change_id: z.string().uuid() }).strict();
function requireValue(condition, code) {
  if (!condition) throw new CapabilityError(code, 'Dedicated write request cannot be completed.');
}
const safeCode = error => error instanceof CapabilityError && /^[A-Z_]{1,80}$/.test(error.code)
  ? error.code : 'SOURCE_UNAVAILABLE';

export class WriteEngine {
  constructor({ authority, journal, port }) { this.authority = authority; this.journal = journal; this.port = port; this.mayHaveDispatched = false; }
  current(expected) {
    const policy = this.authority();
    requireValue(!expected || policy.policyDigest === expected, 'POLICY_CHANGED');
    return policy;
  }
  response(policy, row, requestId) {
    this.current(policy.policyDigest);
    return { ok: row.state === 'CONFIRMED', contract: WRITE_CONTRACT, request_id: requestId,
      change_id: row.change_id, outcome: row.state, operation: row.command.operation,
      record_id: row.evidence.record_id ?? row.command.record_id ?? null,
      policy_digest: row.policy_digest, journal_id: policy.journalId,
      acknowledged: ['ACKNOWLEDGED', 'CONFIRMED'].includes(row.state),
      may_have_dispatched: ['UNKNOWN', 'ACKNOWLEDGED', 'CONFIRMED'].includes(row.state),
      postcondition_observed: row.observation.postcondition_observed ?? null,
      before: row.evidence.before ?? null, expected_after: row.evidence.after ?? null,
      refusal_code: row.refusal_code, observed_at: row.observation.observed_at ?? null,
      created_at: row.created_at, updated_at: row.updated_at,
      upstream_atomic_cas: false, upstream_exactly_once: false, automatic_redispatch: false,
      source_modified_at: null, administrative_resolution: row.administrative_resolution };
  }
  async observe(policy, row) {
    this.current(policy.policyDigest);
    try {
      const actual = await this.port.observe(policy, row.command, row.evidence);
      this.current(policy.policyDigest);
      const observation = { postcondition_observed: digest(actual) === digest(row.evidence.after),
        observed_at: new Date().toISOString() };
      if (row.state === 'ACKNOWLEDGED' && observation.postcondition_observed) {
        return this.journal.confirm(policy.clientId, row.change_id, observation);
      }
      return this.journal.observe(policy.clientId, row.change_id, observation);
    } catch (error) {
      this.current(policy.policyDigest);
      // Failed readback retains the dispatch/ACK boundary. No error body or
      // guessed no-effect outcome enters the durable receipt.
      return this.journal.get(policy.clientId, row.change_id, policy.policyDigest);
    }
  }
  async execute(input) {
    const policy = this.current(), requestId = randomUUID();
    if (input?.action === 'receipt' || input?.action === 'reconcile') {
      const value = lookup.parse(input);
      let row = this.journal.get(policy.clientId, value.change_id, policy.policyDigest);
      requireValue(policy.operations.includes(row.command.operation), 'SCOPE_DENIED');
      if (value.action === 'reconcile') {
        if (row.state === 'PREPARED') row = this.journal.refuse(policy.clientId, row.change_id, 'PRE_DISPATCH_ABANDONED');
        else if (['UNKNOWN', 'ACKNOWLEDGED'].includes(row.state)) row = await this.observe(policy, row);
      }
      return this.response(policy, row, requestId);
    }
    if (input?.action === 'inspect') {
      const value = inspect.parse(input);
      requireValue(policy.operations.includes(value.operation), 'SCOPE_DENIED');
      this.port.validate(value, policy);
      const before = await this.port.inspect(policy, value);
      this.current(policy.policyDigest);
      return { ok: true, contract: WRITE_CONTRACT, request_id: requestId, operation: value.operation,
        before, expected_digest: digest(before), policy_digest: policy.policyDigest, journal_id: policy.journalId,
        retrieved_at: new Date().toISOString(), source_modified_at: null, upstream_atomic_cas: false,
        upstream_exactly_once: false, writes_performed: false };
    }
    const value = apply.parse(input);
    requireValue(policy.operations.includes(value.operation), 'SCOPE_DENIED');
    const command = this.port.validate(value, policy);
    const row = this.journal.reserve({ clientId: policy.clientId, changeId: value.change_id,
      policyDigest: policy.policyDigest, commandHash: digest(command),
      domain: policy.kind === 'shopping' ? 'shopping:' + policy.listId : 'meal:' + policy.userId,
      command });
    if (row.state !== 'PREPARED') return this.response(policy, row, requestId);
    try {
      const evidence = await this.port.prepare(policy, command);
      this.current(policy.policyDigest);
      requireValue(digest(evidence.before) === value.expected_digest, 'PRECONDITION_CHANGED');
      // This durable, one-way boundary precedes every possible upstream write.
      // Any crash from here on is conservatively UNKNOWN until evidence exists.
      this.mayHaveDispatched = true;
      this.journal.begin(policy.clientId, row.change_id, evidence);
      this.current(policy.policyDigest);
      await this.port.dispatch(policy, command, evidence);
      this.journal.acknowledge(policy.clientId, row.change_id);
      this.current(policy.policyDigest);
    } catch (error) {
      this.current(policy.policyDigest);
      const latest = this.journal.get(policy.clientId, row.change_id, policy.policyDigest);
      if (latest.state === 'PREPARED') this.journal.refuse(policy.clientId, row.change_id, safeCode(error));
    }
    let latest = this.journal.get(policy.clientId, row.change_id, policy.policyDigest);
    if (['UNKNOWN', 'ACKNOWLEDGED'].includes(latest.state)) latest = await this.observe(policy, latest);
    return this.response(policy, latest, requestId);
  }
}
