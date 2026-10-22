import { getOAuthClient, getTokenRecord, getUserById } from '../db.js';
import { CapabilityError } from '../../stable/errors.js';

// SDK requestInfo is supplied by the authenticated HTTP/SSE transport for this
// message, not by tool arguments. Bearers are used only for a current DB lookup;
// they never enter closures, receipts, audit output or model-visible errors.
export function assertCurrentWriteRequest(extra, expected) {
  const header = extra?.requestInfo?.headers?.authorization;
  const fail = () => { throw new CapabilityError('CURRENT_AUTHORITY_REVOKED', 'Current write authorization is unavailable.'); };
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) fail();
  const record = getTokenRecord(header.slice(7));
  if (!record || record.expires_at <= Math.floor(Date.now() / 1000)
    || record.client_id !== expected.clientId || record.user_id !== expected.userId) fail();
  const client = getOAuthClient(record.client_id);
  if (!client || !getUserById(record.user_id) || client.redirect_uri
    || !client.client_secret_hash || client.user_id !== expected.userId
    || client.profile !== expected.profile || client.source !== expected.actorSource) fail();
}
