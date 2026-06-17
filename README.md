# @niyi/platform

Shared control-plane library for the sibling apps (LifeOS, HealthPulse, Vantage,
PropertyPulse) and the auth-hub. Single source of truth for:

- **`@niyi/platform/ai`** — Anthropic + Gemini providers with provider preference,
  cross-provider fallback, and Gemini 429 model-fallback. Keys from `process.env`
  (sourced from `shared.env`); provider/model/fallback from the control bus.
- **`@niyi/platform/notify`** — unified Telegram + email + Signal-daemon notifier
  with hub-managed routing / quiet-hours. Never throws.
- **`@niyi/platform/control`** — the control-bundle file-bus: shared zod schemas
  (`ai.json` / `notify.json` / `revocations.json`, each versioned), tolerant
  readers, atomic writers (hub only), and offline `verifyHubToken` + revocation.

## Distribution

Consumers install from git, **pinned by commit SHA** (immutable):

```jsonc
"@niyi/platform": "github:niyiolajide/platform#<commit-sha>"
```

The compiled `dist/` is **committed** to this repo — there is no compile-on-install,
no toolchain or registry required by consumers. CI rebuilds and fails if `dist/`
drifts from `src/`.

## Architecture

The hub publishes config files to a shared host volume (`/control`); apps read them
**offline** (no network call, no single point of failure). API keys live only in
`shared.env` (never web-editable). See the plan for the full control-plane design.

## Develop

```bash
npm install
npm run typecheck
npm test
npm run build   # regenerate dist/ — commit the result
```
