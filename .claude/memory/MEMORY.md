# AnyList MCP — Project Memory

## Global Memory

Read `~/.claude/CLAUDE.md`, `~/.claude/memory/memory.md`, and
`~/.claude/memory/domain/vector72_anylist_mcp.md` first.

## Current status — 2026-07-21

- Fork: `mathiticus3/anylist-mcp`; production is `anylist.vector72.io` on
  `vector72-2` as part of the Trilium web stack.
- v1.7.2 was deployed and verified on 2026-07-15. Recorded suite: 94/94.
- Current branch `fix/lazy-default-list-resolution` backs open, mergeable PR 3.
  Functional fix/release code is based at `11d94d5`; later docs/memory commits
  may advance the PR head. It fixes blank/default-list lazy resolution and
  makes `list_lists` enumerate without prematurely resolving a target list.
- Merge remains deliberately deferred because the release-automation path is
  not yet trusted; deployed production and git branch state are distinct.
- Real credentials, allowed emails, family list contents, and account identity
  values stay in box-side config/Infisical. Never copy them into git, memory, or
  MemSearch.

## Resume gate

Verify production health and the current PR/check state, then either validate
release automation or keep PR 3 open. Do not redeploy merely to make git history
look tidy.
