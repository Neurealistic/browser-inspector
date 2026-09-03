# @neurealistic/browser-inspector

An MCP server that drives a **real Chromium over CDP** for UI / DOM / network inspection. It exposes a
single `run_steps` tool that batches a sequence of actions into one call — primitive Playwright steps,
browser management, authed API calls, and (optionally) methods on your own page objects — with
screenshot / video capture built in.

Unlike a fresh headless launch, it connects to a **persistent** Chrome instance (your logged-in
profile), so flows that need an existing session just work. It can also spawn and reconnect to a
detached Chrome across separate calls, and run N isolated profile clones concurrently.

## Install

```bash
npm i -g @neurealistic/browser-inspector
```

Requires **Node ≥ 22.12** and a system Chrome/Chromium. `curl`, `lsof`, `rsync`, `pkill` and
(for screencast video) `ffmpeg` are used at runtime.

## Use as an MCP server

```jsonc
// .mcp.json / client config
{
  "mcpServers": {
    "browser-inspector": {
      "command": "browser-inspector",
      "env": {
        "INSPECTOR_HOME": "/path/to/your/project",
        "INSPECTOR_PROFILES": "/path/to/browser-profiles.json"
      }
    }
  }
}
```

### Profiles

Define named browser profiles in `browser-profiles.json` (or point `INSPECTOR_PROFILES` at one):

```json
{
  "admin": {
    "binary": "$HOME/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "profile": "$HOME/.browser-inspector/admin",
    "cdpPort": 9222,
    "use": "the app under test",
    "allowedPatterns": ["*.example.com"],
    "blockedPatterns": []
  }
}
```

`allowedPatterns` / `blockedPatterns` gate `page.navigate` per profile (block wins).

## The `run_steps` tool

```jsonc
{
  "browser": "admin",              // profile name (default "admin")
  "screenshot": true,              // shot after each step
  "steps": [
    { "method": "browser.open", "param": "admin" },
    { "method": "page.navigate", "param": "https://example.com" },
    { "method": "pw.fill", "param": { "selector": "#email", "value": "a@b.com" } },
    { "method": "pw.click", "param": "button[type=submit]" },
    { "method": "page.url", "return": "here" }
  ]
}
```

**Namespaces**

- `page.*` — navigate, reload, screenshot, evaluate, url, title, startCapture/getCapture (network + WebSocket), waitForNetworkResponse, waitForWebSocket, clearSession…
- `pw.*` — click, fill, type, press, waitFor, getText, getAttribute, selectOption, isVisible, count, plus a generic passthrough to any Page/Locator method.
- `browser.*` — status, open, close, pages, capture.\* (no page needed).
- `api_user.*` — authed API calls, no page needed (see below).
- **Dynamic import** — `"module/path:ClassName.methodName"` calls a method on your own page object /
  service. Needs `POM_REPO_DIR` (below). Static methods are supported too.

**Cross-step data** — capture a step's result with `"return": "name"`, reference it later with
`{{name}}` or `{{name.path}}` (e.g. `{{otp.code}}`). A lone `{{name}}` preserves the raw value's type.

**Capture** — `screenshot`, `recordVideo` (fresh context, `.webm`), or `screencast` (records the real
CDP browser via `ffmpeg`, `.mp4`). Multi-tab: `page.select` / per-step `onPage` drive any tab without
foregrounding it.

### `api_user` (authed API calls)

Mint + cache bearer tokens against an OAuth login endpoint, then call any `{baseUrl, path}`:

```jsonc
{ "method": "api_user.as", "param": "alice" }
{ "method": "api_user.request",
  "param": { "baseUrl": "https://api.example.com", "path": "/items/{id}", "pathParams": { "id": 123 } },
  "return": "item" }
```

Set `API_OAUTH_LOGIN_URL` (POST `{username, password}` → `{access_token}`). Passwords come from
`<PREFIX><USERNAME>` env vars (`PREFIX` = `INSPECTOR_PASSWORD_PREFIX`, default `API_PASSWORD_`), or the
default `INSPECTOR_API_USER` / `INSPECTOR_API_PASSWORD` pair.

## Environment variables

| Var | Purpose |
|-----|---------|
| `INSPECTOR_HOME` | Base dir for `.env`, captures (`tmp/captures`), and the default profiles/canonical paths. Defaults to cwd. |
| `INSPECTOR_PROFILES` | Path to `browser-profiles.json`. |
| `POM_REPO_DIR` | Repo whose `tsconfig` paths + `@playwright/test` back the dynamic-import steps. Falls back to this package's own `playwright`. |
| `API_OAUTH_LOGIN_URL` | OAuth login endpoint for `api_user`. |
| `INSPECTOR_PASSWORD_PREFIX` / `INSPECTOR_API_USER` / `INSPECTOR_API_PASSWORD` | `api_user` credential resolution. |
| `PROFILE_STORE=1` | Use the canonical profile store (below) instead of `browser-profiles.json`. |
| `AGENT_KEY` | Per-agent id; each agent gets an isolated profile clone + dynamic CDP port. |

## Canonical profile store (optional, `PROFILE_STORE=1`)

A portable, versioned profile layer under `canonical/`: **sources** (OS/browser-agnostic templates) and
**aliases** (`src` + overlay + an encrypted `storageState` session). Sessions are the only portable
auth layer — replayed into a target browser over CDP so it re-encrypts with its own local key (no
ciphertext ever crosses machines). Per-machine binary paths live in a gitignored
`canonical/machine.local.json`. See `src/profile/` (`cli.ts` for CRUD).

## Releasing

Publishing is automated: merge a branch named **`version_x.y.z`** into `main` and the
[`publish`](.github/workflows/publish.yml) workflow builds, publishes `@neurealistic/browser-inspector@x.y.z`
to npm, then tags + releases. (Also runnable manually via **workflow_dispatch** with a version input.)
Requires the repo secret `NPM_TOKEN`.

## License

MIT
