# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Branching workflow

Integration-branch model (simplified git-flow):

- `main` — release branch. Always stable. Only receives merges from `develop`, **squashed**, after the extension is tested in a browser. Store builds are cut from here.
- `develop` — integration branch. Feature branches merge here (regular merge, history preserved) and are tested together.
- `feature/NNN-name` — one per task, branched from `develop`, named after the task it implements. Merged into `develop`, then deleted.

Per-task flow: `git switch develop` → `git switch -c feature/NNN-name` → work → merge into `develop` → test in browser → (when `develop` is stable) squash-merge `develop` into `main`. Never commit directly to `main`. Commit/push only when the user asks.

## What this is

A WebExtension that does two-way bookmark sync between the browser (Firefox MV2 / Chrome MV3) and [Raindrop.io](https://raindrop.io). TypeScript, bundled with webpack, no test suite. Cross-browser support is achieved with `webextension-polyfill` — all code imports `browser` from it (never `chrome.*`).

## Commands

```bash
npm install                  # Install dependencies
npm run watch:firefox        # Dev build + rebuild on change (also watch:chrome)
npm run build:firefox        # Production build → dist/firefox (also build:chrome, build:all)
npm run start:firefox        # Launch browser with the built extension via web-ext
npm run lint                 # web-ext lint against dist/firefox (build first)
npm run package:all          # Build + package both browsers for store submission
```

There is no test runner and no standalone `tsc` typecheck script — type errors surface only through `ts-loader` during a webpack build. After changing code, run `npm run build:firefox` (or `:chrome`) to verify it compiles. `lint` requires `dist/firefox` to already exist.

To load manually: Firefox → `about:debugging` → Load Temporary Add-on → `dist/firefox/manifest.json`; Chrome → `chrome://extensions` → Load unpacked → `dist/chrome/`.

## Build system

`webpack.config.js` takes `--env browser=firefox|chrome` and emits to `dist/<browser>/`. It compiles three entry points (`background`, `popup`, `options`), copies the matching `manifests/<browser>.json` to `manifest.json`, and copies icons + HTML/CSS. `optimization.minimize` is **off** on purpose (store reviewers need readable source). The two manifests are the only browser-specific files: Firefox is MV2 (persistent background page, `browser_action`, `host_permissions` folded into `permissions`); Chrome is MV3 (service worker, `action`, separate `host_permissions`).

## Architecture

All real logic lives in the background script (`src/background/`). The popup and options pages are thin UIs that talk to it exclusively via `browser.runtime.sendMessage`. The single message switch in `src/background/index.ts:handleMessage` is the entry point for every UI action — to add a feature, add a `case` there plus a matching action string in `src/types/messages.ts`.

Both directions flow through **one three-way reconcile** (`syncManager.ts:reconcileAllMappings`), driven by two triggers:

- **Real-time:** `bookmarkListeners.ts` listens to `bookmarks.onCreated/onRemoved/onChanged/onMoved`. Each handler runs cheap relevance guards and, if relevant, arms an 800 ms trailing-debounce timer (`scheduleReconcile`) that dynamically `import('./syncManager')` and calls `reconcileAllMappings()`. Events carry **no payload** — reconcile re-derives everything from the diff. A burst (bulk import, multi-drag) collapses into one pass.
- **Periodic:** the `raindrop-sync-interval` alarm (configurable 1–60 min) calls the same `reconcileAllMappings()`, catching up either direction — including anything a real-time trigger missed (e.g. the MV3 SW died before the debounce fired).

**`reconcileAllMappings` is the core.** For every `BookmarkLink` (the baseline) it compares the browser side and the Raindrop side against the last-synced `contentHash`/`mappingId` and derives a direction via the pure decision module `reconcile.ts` (`decideBookmarkAction`): push / pull / delete-in-raindrop / delete-in-browser / drop-link; both-changed → Raindrop wins. No baseline → union (create/adopt by URL, **never delete**). It also owns nested-folder mirroring (`reconcileFolderTree` / `syncFolderWithChildren`, creates Raindrop collections to match folder trees, depth-capped at `MAX_SYNC_DEPTH`), bidirectional folder rename (`decideRenameAction`), and full re-sync (one global union pass). It holds a stale-tolerant `reconcile_lock` in `storage.local` (5-min timeout) so only one pass runs at a time across SW restarts.

### Loop prevention (the central design problem)

Sync writes bookmarks, which fire bookmark events, which would trigger more reconciles — an infinite loop. Defenses, all of which must be preserved when editing sync code:

- `setSyncing(true/false)` in `bookmarkListeners.ts` maintains a **depth counter** (`syncDepth`, not a boolean — handles concurrent syncs). All event handlers bail early when `isSyncInProgress()`. `reconcileAllMappings` wraps its body in `setSyncing(true)` … `finally setSyncing(false)`.
- **Baseline idempotency**: reconcile decisions compare each side to the `BookmarkLink` baseline, so once a pass has written both sides and updated the baseline, a re-run computes `none` for everything — a self-triggered event finds nothing to do. (This replaces the old queue's per-op `BookmarkLink` re-checks.)
- **Content hashing** (`utils/hash.ts`): `computeBookmarkHash`/`computeRaindropHash` over normalized-URL + title. Changes are skipped when the hash is unchanged. `normalizeUrl` strips tracking params, sorts query params, lowercases host — so trivially different URLs match.
- **URL-level dedup** in reconcile's union phases: an unlinked raindrop whose normalized URL is already linked under any mapping is skipped, and browser-only bookmarks are adopted by URL before creating a new raindrop. This stops the create→event→duplicate-raindrop feedback loop.
- **Teardown cancels the trigger**: `unregisterBookmarkListeners()` (called on disable, disconnect, and last-mapping-removed) clears any armed `scheduleReconcile` timer, so no pass fires after auto-sync is disabled (task 007) or writes into freshly-wiped storage after a disconnect blank-slate (task 011). `reconcileAllMappings` has **no** `enabled` gate by design — the automatic triggers gate before arming the timer, while manual Sync Now deliberately bypasses the toggle.

### State model

`BookmarkLink` (in storage) is the join record tying a `firefoxId` ↔ a `raindropId`, with the last-synced `contentHash` and `mappingId`. Sync is fundamentally "reconcile browser bookmarks, raindrops, and the link table." A `FolderMapping` pairs one browser folder with one Raindrop collection. **Raindrop.io is the source of truth** on conflict.

`storage.ts` wraps `browser.storage.local` and serializes all writes through a `StorageLock` (a thin wrapper over `async-mutex`'s `runExclusive`) for atomicity — use its exported helpers, don't call `browser.storage.local` directly for these keys. Keys/types/defaults are in `src/types/storage.ts`.

`raindropApi.ts` is the only file that talks to `api.raindrop.io`. HTTP goes through a module-level [`ky`](https://github.com/sindresorhus/ky) instance that handles 429 + `Retry-After`, 5xx exponential backoff and network-error retry (max 3, `Retry-After` capped at 120 s); a custom `RateLimiter` (120 req/min sliding window) runs as a `beforeRequest` hook. The token is fetched in `apiRequest` **before** the ky call (so a missing token fails fast rather than being retried), and 401 auto-clears the token. Auth is a Raindrop **Test Token** (not OAuth) stored in local storage. Use its bulk helpers (`createRaindrops`, `getAllRaindropsInCollection`) rather than looping single calls.

### MV3 service-worker constraints

Chrome kills the background service worker when idle, so:

- Bookmark listeners and `initialize()` are registered at the **top level** of `index.ts` (module load), not inside an async callback — otherwise they're lost on SW restart.
- Periodic work is driven by the **`raindrop-sync-interval` alarm**, never `setInterval`. Alarm/message listeners **return the Promise** so the SW stays alive until async work finishes. The real-time debounce is a one-shot `setTimeout`; if the SW dies before it fires, the periodic alarm reconcile catches up (so a missed trigger loses latency, never the change).
- `reconcileAllMappings` uses a stale-tolerant lock in `storage.local` (`reconcile_lock`, 5-min timeout) because an in-memory lock wouldn't survive a SW restart.
- Alarm creation checks for an existing alarm first, to avoid resetting the timer on every SW wake-up.

## Conventions

- Import `browser` from `webextension-polyfill`; the webpack `ProvidePlugin` also injects it globally. Never use `chrome.*`.
- `logger` (`utils/logger.ts`) for all logging; gated by a `debugMode` setting, keeps an in-memory history surfaced via the `getLogHistory` message.
- IDs via `generateId()` (nanoid). `tsconfig` is `strict`.
- Heavy storage helpers are pulled in with dynamic `import()` inside message cases (e.g. `await import('./storage')`) to keep the SW's initial parse light — follow that pattern when adding cases.
