# Dedicated Hub shopping and recipe reads

These source profiles are inactive until separately commissioned. Deploying this
code creates no client, policy, credential, Infisical grant or Hub binding. Preserve
the existing `estate_hub_mealplan_readonly` client and its two secret names.

| Profile | Exact source | Tool / allowed operation | Source policy file |
| --- | --- | --- | --- |
| `estate_hub_shopping_readonly` | `estate-household-shopping-readonly` | `shopping_read` / `list_items` for one pinned list ID | `estate-hub-shopping-read-policy.json` |
| `estate_hub_recipes_readonly` | `estate-household-recipes-readonly` | `recipes_read` / `list` literal name search, `get` exact recipe ID | `estate-hub-recipes-read-policy.json` |

Each file lives in the existing private DATA_DIR. Schema is strictly
`{schemaVersion:1,clientId:<UUID>,userId:<UUID>,enabled:<boolean>,revision:<positive integer>}`;
shopping additionally requires `listId` (32 lowercase hex). The file must be an
owned regular file with no group/other permissions, not a symlink, at most4096bytes.
An absent/disabled policy fails closed. New identities should start disabled.

Client credentials is the sole supported flow: no browser callback binding or
broader full/Gina profile. Token issuance, each bearer request (including existing
MCP sessions), and both sides of upstream I/O check the exact client/account/source
policy. The digest is SHA256 of JSON.stringify of the validated record in schema
order prefixed by contract, profile and source. Policy changes during I/O refuse the
result. Revoke by disabling the dedicated file; do not delete household content.

Shopping returns a complete checked/unchecked snapshot including notes, fixed
list ID and source item IDs. No list discovery, writes or partial snapshots.
Recipes require literal search1..200chars (limit1..20, default10), or exact recipe ID;
name ambiguity is never resolved into a write target. Search order is stable by
source ID and completeness is false when the requested cap omits matches. Exact
absence is complete/not_found. Recipe ingredients/steps are read data; URLs are
never fetched. No import/normalize/save/create/update/delete tools are registered.

Both profiles reject malformed/duplicate upstream IDs, more than10000 source rows,
or a complete MCP response over1MiB. Recipe text fields cap100000chars and
ingredients/steps cap1000 each. Structured and text JSON are identical. Provider
attestation includes client, account, profile, source and policy digest; reads are
explicitly readOnly, mutationsEnabled false. Freshness is retrieval_only and
source_modified_at is null; retrieval proves no source edit timestamp, revision,
CAS or exactly-once semantics. Returned content is untrusted source data.

## Commissioning packet still required

Before access changes, pin reviewed source/Hub commits, selected account and exact
shopping list, distinct new client IDs/secret names, source policy digests, exact-name
Infisical grants, native credential custody and Hub caller grants. Neither existing
meal credentials nor the broad workstation identity may be widened. The current Hub
meal provider does not automatically support these new profiles: a dedicated Hub
provider/adapter and contract tests are a separate prerequisite.

Keep credentials out of output, logs and artifacts. No production mutation canary.
Acceptance must separately prove source admission/denial and revocation, service
read behavior, and actual Gina OAuth caller behavior. Rollback cannot remove the
new profile enforcement while active clients remain: disable/revoke only these
new identities first, reconcile sessions, then restore exact previous code. Preserve
all old clients, source records and unrelated services.
