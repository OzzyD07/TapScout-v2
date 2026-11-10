# TapScout v2: notes for agents working in this repository

TapScout v2 lets an MCP-connected agent drive an Android emulator or iOS Simulator (on GitHub
Actions runners or this machine) with the owner's own app builds. The hub never decides what to
test; the agent does. See README.md for architecture, tools and client constraints.

## Owner decisions

- **No model APIs and no paid services.** Do not add model calls (Nemotron, Nebius, OpenAI…),
  hosted databases, Supabase or Vercel. Storage is plain files in `.data/`; the web UI runs
  locally. Ask before adding any external dependency that costs money or needs an account.
- **Cloudflare quick tunnel: approved** (owner, 2026-11-10). Agents may start it, through the
  hub (`session_start` with `target: "github"`) or directly with `.tools/cloudflared`, to let
  GitHub runners reach the hub, including for verification runs. Conditions:
  - it may only expose the runner gateway port (`TAPSCOUT_GATEWAY_PORT`, default 4781:
    `/healthz`, `/runner/*`, all behind GitHub OIDC or hub-signed tokens), never the UI/MCP
    port 4780;
  - stop it when the GitHub sessions are done (`pnpm hub:stop`, or `TAPSCOUT_TUNNEL=none`);
  - the owner may revisit this (own tunnel via `TAPSCOUT_PUBLIC_URL`, or no tunnel).
- The repository is public: workflow logs must never contain screen content, typed text, tokens
  or tunnel-protected data; artifacts are opt-in (`upload_artifacts`).

## Layout and commands

| Path | What |
|---|---|
| `packages/shared` | hub ⇄ runner protocol, view-space geometry, UI tree normalisation |
| `packages/runner` | device side: Appium control, frames, recordings, logs, reconnects |
| `packages/hub` | MCP server, web UI (`public/`), sessions, gateway, tunnel, GitHub dispatch |
| `apps/sample-app` | FieldNotes test app (not in the pnpm workspace; built by `build-sample.yml`) |

```bash
pnpm install && pnpm build        # build all packages
pnpm check                        # biome + typecheck + tests (must pass before commits)
pnpm setup:local                  # Appium + drivers + cloudflared into .tools/
pnpm hub / pnpm hub:stop          # run / stop the hub (UI + MCP on 127.0.0.1:4780)
node packages/hub/dist/call.js <tool> '<json>' --out <dir>   # call one MCP tool by hand
```

## Conventions

- Code, comments and commit messages in English; the web UI and README in Turkish.
- Every tool call must finish well under 60 s (Claude Code's HTTP MCP timeout); long work is
  asynchronous and polled (`session_status`).
- All coordinates crossing the MCP boundary are view units (pixels of the default screenshot).
- Keep server instructions under 4096 characters (`SERVER_INSTRUCTIONS` in `packages/hub/src/mcp.ts`).
