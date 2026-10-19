# Estate Hub meal-plan reader

`estate_hub_mealplan_readonly` is a dedicated confidential-client profile. It
exposes only `meal_plan_read` / `list_events`, with explicit ISO start/end dates
and at most 31 inclusive days. The handler validates input before acquiring a
provider client, serializes the read, bounds output, and verifies the private
policy again before returning. Shopping, recipes, labels and mutations are not
registered. Existing profiles and GPT Actions remain unchanged.

The private policy binds one existing source account and exact client ID. Token
issuance, every authenticated request and every read check its enabled flag.
Responses attest the exact user/client/profile, policy digest and read-only
contract to the Hub. The Hub must verify those fields and the exact one-tool
catalog before accepting a persistent-provider read. A source role or a tool
description is not sufficient evidence.

`scripts/provision-estate-hub-read.js` defaults to status. Explicit `--provision
--user-id <reviewed-existing-account-uuid>` creates one idempotently named client
and a private credential file. It never prints secret material. A new policy is
disabled. `--enable`, `--disable` and `--revoke` require the exact `--client-id`.
Revocation affects only that dedicated client. Existing and ambiguous partial
credential state is held for reconciliation, not overwritten or regenerated.

Owner entry/transmission is a separate human-controlled step. Do not pipe secret
files through an assistant SSH/tool channel or transplant an existing client.
Only qualified host custody, independent human recovery and the exact approved
Hub binding/grant permit activation. Do not request a token or call a business
tool merely to validate a credential before that handoff is authorized.

Renewal uses the fixed `/oauth/token` endpoint, `client_credentials`,
`client_secret_post`, and `mcp` scope. The response has a 3600-second access
token and no returned refresh token. A Hub must renew with the dedicated client
credential, not with Trilium's authorization-code/refresh implementation.

Build/deploy through `infra/production` from the declared exact live baseline.
Preserve the existing named data volume, all older clients, environment and
peer services. Revoke this new identity before an older-runtime rollback; the
guard refuses restoring a runtime that does not understand its restrictions.
Retain box-local encrypted backups. No raw credential, account address, private
custody path or household meal text belongs in a commit or receipt.
