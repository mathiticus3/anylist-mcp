# Scoped production release

This workflow releases only the existing `anylist-mcp` service. It does not
change Caddy, Trilium, another Compose service, the production Git remote, the
`release/v1.7.3` branch, `.env.anylist`, the email allowlist, or the named data
volume. Production runs the candidate from a detached, digest-verified commit.

The workflow fails closed unless production is still a clean checkout of the
recorded baseline, the current container is healthy, and its image, mounts,
environment digest, network membership, volume identity, and protected files
match the release specification. It records a sanitized container/source/image
checkpoint under `~/.local/state/anylist-mcp/releases/<candidate>`.
The database schema may be either the recorded pre-migration schema or the exact
backward-compatible post-migration schema; any third shape fails closed. This
allows a later release after a runtime rollback that retained the two additive
columns.

## Build and transfer

Build only from a clean release commit:

```powershell
python infra/production/build_release.py
Get-FileHash -Algorithm SHA256 dist/anylist-mcp-<commit>.tar
```

Compare that digest with the adjacent `.sha256` file, then transfer both files
over the already trusted Windows-to-Mac-to-web SSH route. Do not disable strict
host-key checking. Verify the digest on the web host before extracting into a
new mode-700 directory:

```bash
sha256sum --check anylist-mcp-<commit>.tar.sha256
install -d -m 700 release-<commit>
tar -xf anylist-mcp-<commit>.tar -C release-<commit>
```

The tar contains a Git bundle, release specification, manifest, and deployment
program. Every component is checked again before preflight.

## Preflight and deploy

Preflight is read-only and may be repeated:

```bash
cd release-<commit>
python3 deploy_anylist.py preflight
```

Deployment requires the identifier and SHA-256 of the already verified,
encrypted pre-change backup. This records backup provenance without copying or
displaying its separately stored encryption key:

```bash
python3 deploy_anylist.py deploy \
  --backup-id '<encrypted-backup-id>' \
  --backup-sha256 '<64-lowercase-hex-digest>'
```

The deploy operation:

1. repeats preflight and checkpoints source, image, sanitized container state,
   protected-file fingerprints, metadata counts, volume, and other services;
2. fetches only the signed-by-digest bundle commit and detaches the production
   checkout at that exact commit;
3. builds a separate candidate image;
4. runs an authenticated, read-only AnyList protocol smoke with `/data` mounted
   read-only and emits counts/booleans only;
5. takes a SQLite online-backup copy into an isolated temporary volume, applies
   the candidate's additive `oauth_clients.profile` and `oauth_clients.source`
   migration there, and proves the exact old image can open the migrated copy
   without changing account/OAuth counts;
6. retags the proven image and runs exactly `docker compose up -d --no-deps
   --no-build --force-recreate anylist-mcp`;
7. verifies health, OAuth metadata, rejected unallowlisted DCR, unauthenticated
   MCP returning 401, unchanged users/credentials/client counts, OAuth-token
   row integrity, existing credentials, environment, network, bind files,
   volume, and all other service IDs. Token row count may change while clients
   refresh or authorize; it is observed but is not an equality gate.

The post-recreation public health check retries only transient connection reset,
refused, timeout, broken-pipe, and remote-EOF failures within the same bounded
90-second window. An HTTP error, malformed JSON, or non-`ok` health payload
fails immediately.

Any failure triggers rollback. A terminal interruption can be recovered with:

```bash
python3 deploy_anylist.py rollback --candidate '<full-40-character-commit>'
```

Rollback restores the checkpointed image tag and original release branch,
recreates only `anylist-mcp` when the runtime may have changed, and verifies the
old image, health, mounts, protected files, volume, environment, networks,
metadata counts, schema compatibility, and other service IDs. If candidate
startup completed, the two backward-compatible additive columns remain in the
database; the isolated pre-runtime contract test proves the old image accepts
that schema. The encrypted backup remains the disaster-recovery path if the
database itself is ever corrupted.

## Reconcile a restored rollback incident

`reconcile-rollback` does not roll back or recreate a service. Its default is a
read-only dry run for an incident whose original runtime has already been
restored:

```bash
python3 deploy_anylist.py reconcile-rollback \
  --candidate '<full-40-character-incident-commit>'
```

It fails closed unless the source commit/branch/origin, original image,
container health, volume and mounts, environment digest, networks, protected
file fingerprints, all five peer container IDs, compatible schema, exact
nonvolatile account/OAuth counts, SQLite quick check, OAuth-token referential
and expiry integrity, and local/public health all match the checkpoint. It also
requires exact release-owned candidate and rollback tags, candidate image ID
and release label, Git release ref, and known state-file set. It never displays
environment values or token material.

After independent review of the dry-run JSON, cleanup requires the explicit
`--execute` flag. It writes a mode-600 sanitized incident report, removes only
the exact unreferenced release-labeled candidate image/tag, removes only the
rollback alias (never the live original image), compare-and-deletes the exact
Git release ref, and unlinks only the recognized files in the exact incident
state directory. It does not touch source checkout contents, the database,
volume, Compose services, Caddy, or peer services.

## Rollback triggers

Rollback immediately for failed local/public health, failed authenticated
read-only AnyList login, changed metadata counts, OAuth boundary failure,
unexpected image/mount/environment/network identity, protected-file drift, or
any non-AnyList service container-ID change. The workflow never restores the
data backup automatically. Candidate startup performs the documented additive
schema migration; backup restoration is a separately reviewed disaster action,
not part of routine runtime rollback.
