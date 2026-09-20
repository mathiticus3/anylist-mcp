# Bounded shopping v2: new active items, preserving checked history

Status: source preparation only, MCP1.9.5 candidate. Production remains209b39c/MCP1.9.4 and bounded-shopping.v1 with both delivered v1 identities. No v2 deployment, replacement registration, credential delivery or household mutation has occurred. Gina owns harness policy/adapter/journal and independently reviews this provider contract before rollout.

## Change

The owner clarified that checked entries are historical associations, not active shopping entries. Only this separate bounded add profile changes: normalized unchecked matches refuse CONFLICT/NOT_DISPATCHED; checked-only matches permit one distinct new unchecked object through createItem/List.addItem. Historical objects retain their IDs, quantities, checked states, notes and all other fields. There is no uncheck, update, delete, merge or upsert. Existing canary/Gina/full/GPT operations do not change.

Normalization remains NFKC, trim, collapse whitespace, lowercase. All source item checked values must be actual booleans before the shared item view can coerce them. Unknown/missing/malformed state returns INVALID_SNAPSHOT, complete=false and NOT_DISPATCHED. Both reads and add preflight use this validation; malformed unrelated entries also fail closed. Reader continues to include every checked and unchecked item for independent preservation verification.

Canonical identifier remains item identity. Projected snapshot validation refuses generated IDs already present in history before any dispatch. A successful local acknowledgement must retain the attempted ID, requested name and checked=false; otherwise outcome UNKNOWN retains only the attempted candidate ID and requires independent reconciliation. This does not turn a transport ACK into cloud readback or prove exactly-once execution. The unchanged explicit401 library retry, timeout, race and no-CAS limitations remain in BOUNDED-SHOPPING.md.

## Version and approval invalidation

- Package1.9.5; contract `bounded-shopping.v2`.
- Both bounded input schemas require `contract_version` exactly `bounded-shopping.v2`. All previous input constraints remain; omitted/v1 values refuse before client access.
- Binding hash still covers contract version, selected list ID and size/count limits; v2 necessarily yields a different digest. Both client.source strings and initialized sessions must match it.
- Existing v1 registrations cannot silently inherit v2 semantics. Provisioning refuses a conflicting retained registration rather than rebinding it. Existing v1 tokens and newly issued tokens from old credentials are rejected at MCP authentication. The existing token endpoint still validates the confidential identity and may issue an unusable token; successful issuance alone is not a scope qualification.
- Gina must invalidate old schema/source/contract/identity/binding pins and any old approval. No item-action approval is implied by source, setup or read qualification.

Exact target-bearing schemas, candidate hashes and target binding belong in the private provider review artifact. No household name/ID or credentials are committed.

## Smallest guarded migration (not executed)

1. Freeze both new harness identities with actions0/enabled0. Independently review exact source, CI, schema, selected binding and revised collision/postcondition policy.
2. Under explicit correction-rollout/setup authorization, reconfirm production209b39c/image0e56f3da, source drift, health, peer fingerprints and encrypted consistent database/private-file backups. Preserve original canary identities and the dedicated GPT key.
3. Disable add in the private policy. Revoke only gina-bounded-shopping-add and gina-bounded-shopping-read through their supported scripts; remove or retire their exact local v1 files so they cannot be mistaken for v2. No other clients are revoked. These two identities are intentionally unavailable during the bounded migration.
4. Deploy the reviewed candidate from git using its guarded release driver scoped to baseline209b39c. The private policy target/schemaVersion1 remains unchanged; contract version is code-defined. Keep reader enabled and add disabled.
5. Provision the new reader once through the existing script (second invocation must be idempotent). Use its own grant to verify version, contract literal/schema and binding; perform two complete fresh snapshots, strict boolean states and size/order/preservation checks. Deliver the exact reader file privately only under approved delivery authorization.
6. Only after reader qualification, enable and provision add-only under the approved setup scope. Discover its exact schema through its own grant with tools/call0. Back up new credentials encrypted; deliver its exact private file under approved authorization. No add or mutation probes.
7. Gina independently qualifies both identities and reader snapshots, freezes all new hashes and validates active-only collision policy. An absent active item may proceed only through its subsequent exact-action approval. Checked historical matches alone do not authorize execution.

Old local v1 files must not be edited to look like v2. Reprovisioning generates distinct identities and secrets; names and locator paths can remain stable after deliberate replacement. No shared GPT/canary credentials or production-only source edits.

## Containment and rollback

Set addEnabled=false to stop new writes; readerEnabled=false stops both. In-flight work may finish. The candidate release guard explicitly recognizes209b39c and preserves the older canary profiles but requires revoking BOTH v2 bounded identities before restoring v1. Do not bypass the guard or use an older driver. After rollback, these two clients remain unavailable until explicitly restoring their backed-up v1 identity/private files and matching local copies, or deliberately reprovisioning/qualifying v1. Do not restore an entire account database over intervening unrelated consumer state. Existing full/Gina/canary/GPT operations remain the priority.

## Validation

Synthetic tests cover checked-only history allowing one fresh ID with all prior records unchanged, unchecked and mixed matches refusing before creation/dispatch, malformed checked states failing closed, generated duplicate IDs refusing, acknowledgement ID drift remaining UNKNOWN, v1 digest/schema rejection, exact pinned-library protobuf new-item operation preserving history, real local HTTP schema/2509-item transport, old-token/new-token MCP refusal and conflicting reprovision refusal. Release tests cover current baseline and pre-restore revocation enforcement. No production mutation is used to qualify source preparation.
