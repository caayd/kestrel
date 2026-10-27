# Kestrel

Run your own agent harness in a sandboxed box with a live desktop.

- `packages/site`: the static marketing site (Astro + Tailwind): landing and pricing. Deployed as Worker `kestrel-site` on https://kestrel-agent.com.
- `packages/app`: the React SPA (Vite, Tailwind, shadcn/ui, TanStack Query). Talks only to the control plane, same origin.
- `packages/control`: the Cloudflare Worker control plane: GitHub sign-in, connections, and a relay to the agent box. Serves the built `packages/app` as static assets. Deployed as Worker `kestrel` on https://app.kestrel-agent.com (and its workers.dev URL, which boxes dial).
- `packages/server`: the agent box. Runs harnesses inside bubblewrap, serves the desktop and MCP, and dials out to the control plane.
- `packages/protocol`: shared schemas, including the relay frames (`relay.ts`) and control-plane API (`control.ts`).

## Local development

Nothing in the cloud is required. One command starts the whole stack on Linux, macOS and Windows; it needs Bun and Node 22 (for `wrangler`):

```sh
bun install --frozen-lockfile
bun run dev
```

This starts (ports for uid 1000; see below):
- the Worker on http://127.0.0.1:8788 (`wrangler dev`, local Durable Object state in `packages/control/.wrangler`),
- a box on 127.0.0.1:8797 connected to that Worker (data in `.data-dev/`); 8787 is left to the production box,
- Vite on http://localhost:5173.

Open the printed URL (`/auth/dev-login`) to sign in as `dev`. The first run creates `packages/control/.dev.vars` with a random local box token and builds `packages/app/dist`, which the Worker serves. Output is prefixed `[worker]`, `[box]` and `[app]`; Ctrl+C stops all three, and so does any one of them exiting. `CLOUDAGENTS_FAKE_AGENT=1 bun run dev` runs a scripted agent that needs no model key.

### Nix

`nix run` runs the same `bun run dev` with the flake's toolchain (Bun, Node, wrangler, bubblewrap, pasta, the desktop stack). Nix is what turns the agent sandbox on: the sandbox exposes only `/nix/store` and a toolchain directory from it (`CLOUDAGENTS_SANDBOX_PATH`, `CLOUDAGENTS_SANDBOX_SSL`, set by the flake). On NixOS use the flake: the npm `workerd` binary that `bunx wrangler` runs does not start there, so the flake passes its own wrangler in `KESTREL_WRANGLER`.

### Without Nix

Without `CLOUDAGENTS_SANDBOX_PATH`, `bun run dev` starts the box with `CLOUDAGENTS_SANDBOX=0`, which runs agents unsandboxed: fine for local work with the fake agent or your own key, never for a shared or production box. Set `CLOUDAGENTS_SANDBOX` yourself to override that.

- **Linux:** the task desktop needs Xvfb, openbox, xterm, xdotool and an ffmpeg built with x11grab. Add `CLOUDAGENTS_SYSTEMD=0` if you have no user systemd manager.
- **macOS and Windows:** no task desktop (Xvfb and x11grab are Linux-only; runs go ahead without a display and the task says why) and no resource limits (`bun run dev` sets `CLOUDAGENTS_SYSTEMD=0`).
- **Windows:** agent commands and `workspace_exec` run through POSIX `sh`: the one on `PATH`, else the one from Git for Windows. Each process the box starts gets its own job object, so cancelling a run or stopping the stack also ends whatever it started. There is no uid, so ports move only with `KESTREL_DEV_SLOT`.

### Shared dev machine

Several people can run `bun run dev` (or `nix run`) on one machine, each from their own clone under their own Linux user, and each person can run several worktrees at once. Ports are offset by `(uid - 1000) * 100 + KESTREL_DEV_SLOT * 10` (slot 0-9, default 0; `KESTREL_DEV_OFFSET` overrides the whole offset): uid 1001 slot 0 gets app 5273, Worker 8888, box 8897; slot 1 adds 10 to each. The ports are printed at startup. From your laptop, forward the app port and open it locally:

```sh
ssh -L 5273:localhost:5273 <you>@<dev-machine>
# then open http://localhost:5273/auth/dev-login
```

Working with agents or in parallel: see [AGENTS.md](AGENTS.md) (one git worktree and one PR per change).

Agents need a model key: add one on the Connections page, or export `ANTHROPIC_API_KEY` before starting the box (the box's broker uses it as a fallback; the sandbox only ever sees a per-run token).

### Agent sandbox

Everything an agent controls runs in bubblewrap inside a transient systemd scope: the agent run, every `workspace_exec`, the desktop terminal and apps started with `desktop_launch`. Each task gets a slice `kestrel-box<port>-t<task>.slice` (under `kestrel.slice`) whose limits cap all of the task's processes together; swap is off for it, so the memory limit is hard and the kernel OOM-kills inside the task only.

Each task also has its own network namespace, made by `pasta` (passt) when the task first launches something and shared by all of that task's sandboxes, so a browser on the task desktop reaches the agent's dev server on `localhost`. Outbound internet works through pasta's user-space NAT. The host's `127.0.0.1` is out of reach except the box port, which is forwarded in for the broker and MCP. Other tasks' servers and X servers that listen on abstract sockets (such as a desktop session's `:0`) are out of reach too, and the task's own servers are not published on the host. The LAN and the host's non-loopback addresses are still reachable. pasta and its holder process live in the task slice and go away with the task.

| Variable | Default | Meaning |
|---|---|---|
| `CLOUDAGENTS_TASK_MEMORY_MAX` | `4G` | systemd `MemoryMax` per task |
| `CLOUDAGENTS_TASK_CPU_QUOTA` | `200%` | systemd `CPUQuota` per task (100% = one core) |
| `CLOUDAGENTS_TASK_TASKS_MAX` | `1024` | systemd `TasksMax` (processes + threads) per task |
| `CLOUDAGENTS_SYSTEMD` | on | `0` runs without limits (machines without a user systemd manager) |

The box needs the user's systemd manager (`systemd-run --user`) with the memory, cpu and pids controllers delegated (the default on systemd distros). It checks this at startup and refuses to start otherwise; a box that outlives your login session (the production box) needs `loginctl enable-linger <user>`. At startup the box also stops its own slice, killing sandboxes a previous instance left behind; deleting a task stops its slice and drops its limits. Inspect live sandboxes with `systemd-cgls --user-unit kestrel.slice`.

Signed-in users can instead run agents on their own Claude or ChatGPT subscription: sign in on the Connections page (the box runs the unmodified `claude auth login` / `codex login --device-auth` in that user's directory). Each user's CLI state lives only on the box under `<CLOUDAGENTS_DATA_DIR>/users/<login>/{claude,codex}`, and the box's CLI runs use their own login; the sandbox sees just the directories of the providers that user has signed in to. Those runs use the login in place of the broker's API key for that provider.

Projects are private to the user who added them: the box answers every project, task, run, diff and desktop route (REST and WebSocket) only for the project's owner and returns `404` to anyone else. The box clones with the adding user's own GitHub token, so GitHub decides which repositories someone can import, and the broker pays for a run with the keys of the user who started it. Projects saved before owners existed are dropped from the box state at startup (logged; their files stay on disk).

Checks: `bun run typecheck`. Marketing site: `bun run dev:site` (Astro on http://localhost:4321).

## Deploys

- **App and control plane:** Workers Builds deploys `main` (build `bun run build:app`, then `wrangler deploy` in `packages/control`). To deploy by hand: `bunx cf builds create d87f7f0a-5dee-45c5-bb88-e5829c3a7792 --branch main`.
- **Marketing site:** Workers Builds deploys `main` (build `bun run build:site`, then `wrangler deploy` in `packages/site`). Links to the app use `PUBLIC_APP_URL` (default `https://app.kestrel-agent.com`).
- **GitHub sign-in** needs a GitHub OAuth app whose callback URL is `https://app.kestrel-agent.com/auth/github/callback`, with `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` set as secrets on Worker `kestrel`.
- **Production box:** runs on the host machine with `nix run .#box-auto`. It keeps its own clone of `main` in `~/.local/share/kestrel-box` (override with `KESTREL_BOX_DIR`), polls GitHub every 60 s (`KESTREL_BOX_POLL`), and on a new commit fast-forwards and restarts the box, which interrupts in-flight agent runs. It reads `CLOUDAGENTS_CONTROL_URL` and `CLOUDAGENTS_BOX_TOKEN` from `.box.env` in that clone (copied from the current directory on first run). `nix run .#box` runs a box once from the current checkout.

Don't run a box against production with the production token from your machine: the control plane keeps one box and a new connection replaces the live one.

Pull requests get isolated Previews at `https://<branch>-kestrel.jarenmchugh.workers.dev` (app) and `https://<branch>-kestrel-site.jarenmchugh.workers.dev` (site), branch name with `/` replaced by `-`. The app Preview has its own empty Hub, no production secrets and no box, so it is for UI review.
