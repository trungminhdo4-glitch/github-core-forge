# github-core-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/trungminhdo4-glitch/github-core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/trungminhdo4-glitch/github-core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in plain Node 22 with no dependencies: one process,
one in-memory store, four surfaces.

- **git smart HTTP** at `/<owner>/<repo>.git`: upload-pack protocol v2 (`ls-refs` with symrefs,
  peeled tags and ref prefixes; `fetch` with shallow clones and deepening, side-band-64k) with a v0
  fallback, and receive-pack v0 (report-status, side-band-64k, delete-refs, per-ref fast-forward
  checks). Packs are read and written in-process (SHA-1 and zlib from Node; ofs/ref deltas resolved
  on push); no git binary.
- **REST v3** under `/api/v3`: repositories (with `Link` pagination), branches, refs, commits,
  contents (create, update with stale-sha 409, delete), labels, issues, comments, pull requests,
  their files and squash/merge/rebase merges with three-way conflict detection.
- **GraphQL v4** at `/api/graphql`: a small parser and executor over a typed schema that drives
  validation and introspection (`__type`), Relay connections with cursors, global node ids,
  operation batching, and the queries and mutations `gh` and `github-mcp-server` send.
- **MCP** at `/mcp`: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28 (`server/discover`) and
  the handshake revisions (`initialize`), with repository, issue and pull-request tools acting on the
  same store as REST.

Nothing reads the wall clock or `Math.random`: timestamps come from a logical clock seeded by
`MAKEFUN_TRIAL_NOW`, so a replayed run produces the same objects.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

`main.ts` binds an ephemeral port, registers it with the env at `MAKEFUN_ENV_URL`, and exits once the
env reports done. Every API call needs `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | the entry/env lifecycle (unchanged from the starter) |
| `app.ts` | the HTTP server: routing, auth, request ids, JSON bodies |
| `git.ts` | objects, trees, commits, tags, pack reading/writing, fetch reachability |
| `githttp.ts` | smart HTTP: advertisements, v2 `ls-refs`/`fetch`, v0 upload-pack, receive-pack |
| `store.ts` | users, repositories, refs, labels, issues, pull requests, the logical clock |
| `ops.ts` | operations shared by all surfaces: contents, issues, pulls, merges, diffs |
| `rest.ts` | REST v3 routes and GitHub-shaped JSON |
| `graphql.ts` | GraphQL parser, schema, introspection and resolvers |
| `mcp.ts` | the MCP endpoint and its tools |

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
