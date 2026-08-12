# Gina / OpenWebUI profile

The HTTP server assigns a bounded tool profile from the OAuth callback URI. It
does not trust the caller's display name or prompt as an authorization signal.

The exact callback for the OpenWebUI connector whose ID is `anylist` is:

```text
https://cdlms.tail767e55.ts.net:8443/oauth/clients/mcp:anylist/callback
```

New dynamic registrations are accepted only for exact callbacks in the
server-side allowlist. The Gina callback, Claude callback, and Home Assistant
callback are built in. Additional exact HTTPS (or loopback HTTP) callbacks may
be added with `OAUTH_ALLOWED_REDIRECT_URIS`; the value is a JSON array. Existing
registered clients remain usable at their originally registered callback.

## Gina tool surface

An OAuth client registered with the exact Gina callback receives only these
tools:

| Tool | Allowed operations | Safety annotation |
|---|---|---|
| `health_check` | Connection test | read-only |
| `shopping_read` | list lists/items/categories/stores, favorites, recents | read-only |
| `shopping_add_item` | add one previously absent item | additive |
| `recipes_read` | list and get | read-only |
| `recipes_create` | create one recipe with a new name | additive |
| `meal_plan_read` | list events and labels | read-only |
| `meal_plan_create` | create one event | additive |
| `recipe_collections_read` | list | read-only |
| `recipe_collections_create` | create one collection with a new name | additive |

Deletes, check/uncheck, updates, category mutation, bulk item insertion, URL
imports, and recipe normalization with saving are not registered in this
profile. Add operations reject an existing item, recipe, or collection name so
an apparent create cannot silently become an update or overwrite.

The profile and provenance source (`gina/openwebui`) are persisted on the OAuth
client. Access logs record the source and a shortened client ID but never MCP
request bodies, list contents, recipe contents, credentials, or login email.
MCP sessions are bound to the OAuth client and user that initialized them.

Legacy clients retain the original five full, domain-grouped tools. Those tools
now carry conservative MCP annotations (`destructiveHint` for mixed destructive
surfaces and `openWorldHint` for recipe URL access).

## OpenWebUI connector

Configure an External Tool Server with:

- Type: MCP Streamable HTTP
- ID: `anylist`
- URL: `https://anylist.vector72.io/mcp`
- Authentication: OAuth 2.1

Use OAuth registration and the normal server login flow. Do not paste AnyList
credentials, OAuth bearer tokens, or a client secret into the connector URL.
No OpenWebUI tool-name filter is required for security; the server profile is
the enforcement boundary.

## Operational limits

Dynamic registration is limited per source IP and by a global public-client
quota. Defaults are five registrations per hour per IP and 25 public clients.
Reaching the quota blocks only new registrations and does not revoke existing
clients. Confidential clients remain an explicit operator action through
`scripts/create-client.js` and retain the full profile.

## Deployment prerequisites

This branch must not be deployed from an untrusted workstation connection.
Before changing the live service:

1. Establish trusted SSH access to `vector72-2` and verify its host key through
   the existing operations channel; never bypass host-key checking.
2. Reconcile the exact deployed AnyList repository commit and any host-local
   changes before replacing it with this branch.
3. Complete and verify an encrypted pre-change backup of the `/data` volume,
   deployment `.env` (including `SERVER_SECRET_KEY`), and email allowlist using
   [backup.md](backup.md).
4. Record the current OAuth-client count and verify the chosen DCR quota will
   not block the OpenWebUI registration.
5. Build and recreate only `anylist-mcp`, then verify `/health`, an existing
   Claude or confidential client, and unauthenticated `/mcp` returning 401.
6. Register the `anylist` connector in OpenWebUI and confirm its advertised
   tool list exactly matches the bounded Gina surface above before enabling it
   for Gina.
7. Exercise one read in each domain. Exercise an additive operation only with
   a disposable, explicitly authorized record; confirm delete, bulk, overwrite,
   update, and import operations are absent.

If the backup, trusted access, deployed-state reconciliation, or tool-list
acceptance fails, leave the live service unchanged.
