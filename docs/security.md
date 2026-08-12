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

## AnyList client compatibility boundary

The published `anylist` dependency was removed. The service already used its
customized `anylist-js` submodule directly; the package existed only to bring in
runtime dependencies and forced protobufjs 5 and uuid 3 into production.

The customized client now runs on protobufjs 8.7.2 through a narrow local
adapter. The adapter converts only the fixed bundled v5 reflection schema,
marks it as proto2, validates schema identifiers, and implements the constructor,
field accessor, enum, static decode, and instance `toBuffer()` behavior used by
the client. Protocol fixtures emitted by the previous v5 runtime cover shopping
items, list operations, recipes, and calendar operations. The legacy
`uuid/v4` import resolves to a local compatibility package backed by Node's
cryptographic `randomUUID()` implementation.

Both `npm audit` and `npm audit --omit=dev` report zero findings in the validated
lockfile. The `tmp` override applies only to the MCPB packaging tool's dependency
chain and is verified by the package build.

The remaining risk is architectural rather than a known vulnerable dependency:
AnyList has no official public API, so this reverse-engineered protocol can
change without notice. Mocked tests and bidirectional protobuf wire checks do
not replace an authenticated integration test against a disposable list before
deployment. Keep the service behind its authenticated HTTPS endpoint, retain
the bounded Gina profile, and do not grant the container broader network or
filesystem access.
