# Backup and restore

AnyList MCP stores account records, OAuth clients/tokens, and encrypted AnyList
credentials in the `anylist_data` Docker volume. The ciphertext is not useful
without `SERVER_SECRET_KEY`, which lives in the deployment `.env` file.

Back up these items as one recoverable set:

1. The complete `anylist_data` volume, including SQLite `-wal` and `-shm` files.
2. The deployment `.env`, especially `SERVER_SECRET_KEY` and `SESSION_SECRET`.
3. `config/allowed-emails.txt` and the deployed compose/Caddy configuration.

Do not print or copy secret values into tickets, chat, shell history, or logs.
Store the backup in an encrypted backup system with access limited to the
service operator. Losing `SERVER_SECRET_KEY` makes the stored AnyList account
credentials undecryptable; exposing it together with the database exposes
those credentials. Changing `SESSION_SECRET` invalidates browser sessions.

## Consistent snapshot procedure

Use the deployment runbook's backup system. If taking a manual volume snapshot,
resolve and verify the service's `/data` volume before stopping it:

```bash
docker compose ps --all anylist-mcp
docker inspect "$(docker compose ps --all -q anylist-mcp)"
```

From that read-only inspection, record the exact named volume mounted at
`/data`. Stop only the AnyList service so SQLite and its WAL are consistent,
snapshot that explicit verified volume with the host's encrypted backup tool,
and back up the deployment `.env` and allowlist in the same set. Then restart
the service and verify `/health`:

```bash
docker compose stop anylist-mcp
# Run the approved encrypted backup job against the verified named volume.
docker compose start anylist-mcp
curl --fail --silent https://anylist.vector72.io/health
```

Do not create an unencrypted tarball of `.env`. The database may be copied as
ciphertext, but the combined backup set must be encrypted because it contains
the decryption key and OAuth/session material.

## Restore acceptance

Restore into a non-public test environment first. Verify:

- the container becomes healthy;
- an existing OAuth client can refresh or reauthorize;
- `health_check` succeeds after login;
- a Gina callback receives only the bounded Gina tool list;
- a restored credential can be decrypted without displaying it.

Test a restore after initial deployment and at least quarterly. A backup that
has not passed restore acceptance is not considered durable.
