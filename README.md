# @niyi/platform

Shared control-plane library for the sibling apps (LifeOS, HealthPulse, FinPulse,
PropertyPulse) and the auth-hub. Single source of truth for:

- **`@niyi/platform/ai`** — Anthropic + Gemini providers with provider preference,
  cross-provider fallback, and Gemini 429 model-fallback. Keys from `process.env`
  (sourced from `shared.env`); provider/model/fallback from the control bus.
- **`@niyi/platform/notify`** — unified Telegram + email + Signal-daemon notifier
  with hub-managed routing / quiet-hours. Never throws.
- **`@niyi/platform/control`** — the control-bundle file-bus: shared zod schemas
  (`ai.json` / `notify.json` / `revocations.json`, each versioned), bounded
  readers, guarded writers (hub only), and offline `verifyPulseToken` + revocation.

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

## Releases

Every release is an annotated tag `vX.Y.Z` on `main`; `package.json` `version` and the tag
always match. Cut one with:

```bash
scripts/release.sh minor        # or patch / major / an explicit X.Y.Z
```

The script refuses to run on a dirty tree, off `main`, out of sync with origin, or when
`dist/` is older than `src/` (build in Docker via `npm run verify-dist` and commit dist
first). Consumers pin git SHAs/tags — roll them forward with
`~/scripts/host-infra/bump-libs.sh`.

## Revocation failures and publication

`@niyi/platform/control` retries unstable or invalid revocation reads three times
with short backoff. If no valid snapshot is available, token verification denies
by default, `checkJtiRevocation()` returns `unavailable`, `isRevoked()` returns
true, and `readRevocations()` throws `RevocationsUnavailableError`. A missing or
malformed bundle never becomes an empty denylist.

Operators may explicitly set `CONTROL_REVOCATIONS_GRACE_MS` to allow a previously
validated snapshot during an outage, capped at 60 seconds. The default, blank or
invalid value is zero: stale authentication requires a deliberate opt-in. During
an enabled grace interval, a newly revoked token may still be accepted. A process
with no previously validated snapshot always denies. The interval uses a monotonic
clock, and successful local publication invalidates older cached snapshots.

`revokeJti()` merges observed revocations with bounded conflict retries.
`publishRevocations()` deliberately replaces the list, including un-revoke by
omission, and throws on observed concurrent interference; callers must re-read
and deliberately re-issue a conflicted replacement. A successful result proves
the observed revocations survived the final verification read. Writers that do
not share the publication lock can still write after that read; this library
cannot make their independent writes atomic. Exact-file Docker binds continue
to require their existing publisher, while these reader protections apply to
all consumers after they adopt this commit.
