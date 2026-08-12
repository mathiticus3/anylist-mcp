# Security boundary and residual risks

The HTTP service is a privileged boundary over a family AnyList account. OAuth
authentication, the allowed-email list, and server-side tool profiles are the
authorization controls. Prompts and OpenWebUI tool filters are not controls.

## Enforced in this branch

- Dynamic OAuth registration accepts one exact allowlisted callback, public
  clients only, with S256 PKCE.
- The authorization and token exchanges bind the client ID and redirect URI.
- New registrations have a per-IP hourly rate limit and a persistent global
  public-client quota.
- The exact Gina/OpenWebUI callback receives only read and single-record
  additive tools. The callback, not `client_name`, selects the profile.
- MCP session IDs cannot be replayed by a different OAuth client or user.
- MCP request bodies, AnyList content, login email, credentials, and bearer
  prefixes are excluded from server logs. Access records carry only a source,
  shortened client ID, user ID, route, status, and timing.
- Full legacy tools publish conservative MCP safety annotations.

## Compatibility choices

An already registered client remains valid only at its stored exact callback,
even if that callback is no longer available for new dynamic registrations.
This preserves current Claude and other clients while preventing callback
substitution. Audit and remove stale OAuth-client rows operationally.

Legacy confidential clients that have no stored callback may bind once to a
currently allowlisted callback. Subsequent authorization requires the same
exact callback.

The registration rate limiter is in process and resets on restart. The global
client quota is stored in SQLite and remains the durable denial-of-registration
control. A reverse proxy may add an additional edge rate limit, but it must not
replace the application controls.

## Unresolved upstream dependency risk

The reverse-engineered AnyList client is pinned to the obsolete protobufjs 5
builder API and uuid 3. `npm audit --omit=dev` reports one critical, one high,
and one moderate production finding through that package, with no compatible
upstream fix. The service loads a fixed bundled protobuf schema and requires
OAuth before tool invocation, which narrows exposure but does not remove the
runtime and supply-chain risk.

The MCP SDK was upgraded to 1.30.0 to remove known cross-client and ReDoS
findings, and non-forced dependency updates were applied. The remaining
AnyList-client findings require a deliberate port to a maintained protobuf API
or replacement of the unofficial client; forcing a major protobuf override
would break its `newBuilder()` API and is not an acceptable security fix.

Do not describe this service as fully hardened until that client migration is
complete. Keep the service behind its authenticated HTTPS endpoint, retain the
bounded Gina profile, and avoid granting broader network or filesystem access
to the container.
