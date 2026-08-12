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
5. retags the proven image and runs exactly `docker compose up -d --no-deps
   --no-build --force-recreate anylist-mcp`;
6. verifies health, OAuth metadata, rejected unallowlisted DCR, unauthenticated
   MCP returning 401, unchanged account/OAuth counts, existing credentials,
   environment, network, bind files, volume, and all other service IDs.

Any failure triggers rollback. A terminal interruption can be recovered with:

```bash
python3 deploy_anylist.py rollback --candidate '<full-40-character-commit>'
```

Rollback restores the checkpointed image tag and original release branch,
recreates only `anylist-mcp` when the runtime may have changed, and verifies the
old image, health, mounts, protected files, volume, environment, networks, and
other service IDs.

## Rollback triggers

Rollback immediately for failed local/public health, failed authenticated
read-only AnyList login, changed metadata counts, OAuth boundary failure,
unexpected image/mount/environment/network identity, protected-file drift, or
any non-AnyList service container-ID change. The workflow never restores the
data backup automatically; that backup is for a separately reviewed disaster
restore because this release never writes or migrates the database directly.
