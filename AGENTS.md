# AGENTS.md

Instructions for humans and coding agents working on Kestrel. Several people and several agents work in
parallel on one shared machine, so the workflow below is mandatory.

## The rules

1. **One change = one git worktree = one branch = one PR.** Never edit the main checkout, never work on `main`.
2. **`main` is protected.** Direct pushes are rejected; everything lands through a PR (squash merge).
3. **Merging to `main` deploys.** It redeploys the app (`app.kestrel-agent.com`) and site (`kestrel-agent.com`)
   and restarts the production box, which kills in-flight agent runs. Agents open PRs; merge only when the
   human you work for says so.
4. **Never touch production.** Don't call `127.0.0.1:8787` (the production box), don't read or copy `.box.env`,
   don't deploy with `wrangler deploy` by hand, don't print or commit secrets (`.dev.vars`, API keys, tokens).
5. **`packages/protocol` is shared by every package.** Changes there need a heads-up to everyone in the PR description.

## Worktree flow

Start a change (from the main clone, e.g. `~/kestrel`):

```sh
git fetch origin
git worktree add ../kestrel-worktrees/<topic> -b <github-login>/<topic> origin/main
cd ../kestrel-worktrees/<topic>
bun install --frozen-lockfile
```

Work and open the PR:

```sh
# ... small logical commits ...
git fetch origin && git rebase origin/main      # keep up to date; force-push your own branch only
git push -u origin HEAD                          # or: git push --force-with-lease after a rebase
gh pr create --fill                              # title: what changed; body: why + how you verified
```

Clean up after the PR is merged (yours, or one you were asked to merge). Stop that worktree's stack first,
and run this from the main clone, not from inside the worktree:

```sh
gh pr view <github-login>/<topic> --json state -q .state   # must print MERGED; squash merges never show in git history
git worktree remove ../kestrel-worktrees/<topic>           # refuses if there are uncommitted changes: check, don't --force
git branch -D <github-login>/<topic>
git pull --ff-only origin main
```

`git worktree list` shows what is still around; clean up every merged one.

- Branch names: `<github-login>/<topic>`, e.g. `caayd/install-link`.
- Every PR gets a Preview: `https://<branch with / replaced by ->-kestrel.jarenmchugh.workers.dev` (app; its own
  empty Hub, no secrets, no box, so UI review only) and `...-kestrel-site.jarenmchugh.workers.dev` (site).
- Each worktree has its own `node_modules`, `.data-dev/`, `packages/control/.dev.vars` and `.wrangler/` state.
- Dependencies are shared, not duplicated: bun hardlinks every package from its global cache
  (`~/.bun/install/cache`), and the flake's tools come from `/nix/store`, so a new worktree installs in about a second
  and costs almost no disk. Don't copy or symlink `node_modules` between worktrees; run `bun install` in each.
- Nix is optional. The flake pins the toolchain and gives you `nix run` with the agent sandbox; without Nix, install
  Bun and Node 22 and use `bun run dev` (see "Without Nix" in `README.md`).

## Running the stack from a worktree

```sh
KESTREL_DEV_SLOT=1 CLOUDAGENTS_FAKE_AGENT=1 bun run dev   # any OS; agents unsandboxed
KESTREL_DEV_SLOT=1 CLOUDAGENTS_FAKE_AGENT=1 nix run       # Linux with Nix: same script, sandboxed
```

- Either starts the Worker, a dev box and Vite, and prints its ports. `nix run` installs dependencies on first run;
  run `bun install --frozen-lockfile` yourself before `bun run dev`.
- Ports are unique per Linux user and per `KESTREL_DEV_SLOT` (0-9). **Give every worktree that runs at the same
  time its own slot**, or the second stack fails on a busy port.
- **At most one stack per worktree.** The local Worker state (`.wrangler/`) is per directory; a second stack
  in the same worktree dies with `SQLITE_BUSY`. Need two stacks? Use two worktrees.
- `CLOUDAGENTS_FAKE_AGENT=1` runs a scripted agent (no model key, exercises MCP and the desktop). Use a real key only
  when you need a real agent (`ANTHROPIC_API_KEY=... bun run dev`, never committed).
- Sign in at `http://localhost:<app port>/auth/dev-login`. From a laptop: `ssh -L <port>:localhost:<port> <you>@<machine>`.
- Marketing site only: `cd packages/site && bunx astro dev --port <n>` (default 4321). It runs in the background;
  stop it with `bunx astro dev stop` from the same directory.

## Before opening a PR

```sh
bun run typecheck      # all 5 packages, must pass
bun run build:app      # if packages/app changed
bun run build:site     # if packages/site changed
```

Then exercise the change for real: run the stack, click through the affected flow (or call the endpoint), and
say in the PR what you ran and what you saw. There is no CI; the PR description is the evidence.

## Repo map

| Path | What | Notes |
|---|---|---|
| `packages/app` | React SPA (Vite, Tailwind v4, shadcn/ui, TanStack Query) | Imports via `@/`. UI primitives in `src/components/ui` (`bunx shadcn add <x>`). All query keys and options live in `src/api/queries.ts`; REST calls in `src/api/client.ts`; live events write into the query cache (`src/hooks/useTaskState.ts`). |
| `packages/control` | Cloudflare Worker: GitHub OAuth, sessions, control API, relay to the box | `src/hub.ts` is the single Durable Object. Serves `packages/app/dist` as assets. |
| `packages/site` | Astro static marketing site | App links go through `APP_URL` in `src/config.ts`. |
| `packages/server` | The agent box: harness, bwrap sandbox, MCP, broker, desktop | Effect services wired in `src/main.ts`. Agent tools in `src/mcp/handler.ts`; harness command in `src/config.ts`. |
| `packages/protocol` | Effect Schema types shared by everything | Relay frames (`relay.ts`), control API (`control.ts`), domain + REST (`index.ts`). |
| `docs/architecture.md` | Diagram and who owns what | Read it before touching an area you don't own. |

## Conventions

- TypeScript strict everywhere; validate data crossing a boundary with the Effect schemas in `packages/protocol`.
- Keep changes scoped to the task; no drive-by refactors in someone else's area.
- Delete code you replace; don't leave fallbacks or commented-out code.
- Secrets never reach the agent sandbox; model keys go through the broker (`packages/server/src/broker`).
