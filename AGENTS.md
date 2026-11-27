This file provides guidance to AI when working with code in this repository.

## Branching workflow

Integration-branch model (simplified git-flow):

- `main` — release branch. Always stable. Only receives merges from `develop`, **squashed**, after the extension is tested in a browser. Store builds are cut from here.
- `develop` — integration branch. Feature branches merge here (regular merge, history preserved) and are tested together.
- `feature/NNN-name` — one per task, branched from `develop`, named after the task it implements. Merged into `develop`, then deleted.

Per-task flow: `git switch develop` → `git switch -c feature/NNN-name` → work → merge into `develop` → test in browser → (when `develop` is stable) squash-merge `develop` into `main`. Never commit directly to `main`. Commit/push only when the user asks.

## What this is

A WebExtension that does two-way bookmark sync between the browser (Firefox MV2 / Chrome MV3) and [Raindrop.io](https://raindrop.io). TypeScript, bundled with webpack; Vitest tests live in `src/**/*.test.ts`. Cross-browser support is achieved with `webextension-polyfill` — browser API users import `browser` from it (never `chrome.*`).

## Commands

```bash
npm install                  # Install dependencies
npm run watch:firefox        # Dev build + rebuild on change (also watch:chrome)
npm run build:firefox        # Production build → dist/firefox (also build:chrome, build:all)
npm run start:firefox        # Launch browser with the built extension via web-ext
npm run lint                 # web-ext lint against dist/firefox (build first)
npm test                     # Run Vitest tests once (also test:watch)
npm run package:all          # Build + package both browsers for store submission
```

Run `npm test` for the Vitest suite (`vitest.config.ts` uses a Node environment). There is no standalone `tsc` typecheck script — type errors surface through `ts-loader` during a webpack build. After changing code, run `npm run build:firefox` (or `:chrome`) to verify it compiles. `lint` requires `dist/firefox` to already exist.

To load manually: Firefox → `about:debugging` → Load Temporary Add-on → `dist/firefox/manifest.json`; Chrome → `chrome://extensions` → Load unpacked → `dist/chrome/`.

## Build system

`webpack.config.js` takes `--env browser=firefox|chrome` and emits to `dist/<browser>/`. It compiles three entry points (`background`, `popup`, `options`), copies the matching `manifests/<browser>.json` to `manifest.json`, and copies icons + HTML/CSS. `optimization.minimize` is **off** on purpose (store reviewers need readable source). The two manifests are the only browser-specific files: Firefox is MV2 (persistent background page, `browser_action`, `host_permissions` folded into `permissions`); Chrome is MV3 (service worker, `action`, separate `host_permissions`).

## Architecture

Sync logic lives in `src/background/`, with shared pure helpers in `src/utils/`. The popup and options pages send actions to the background via `browser.runtime.sendMessage`; the options page also listens for storage/bookmark changes to refresh its UI. The single message switch in `src/background/index.ts:handleMessage` handles UI actions. To add an action, add a `case` there and call it from the UI; `src/types/messages.ts` defines the request/response shapes but does not enumerate action strings (`action: string`).

Both directions flow through **one three-way reconcile** (`syncManager.ts:reconcileAllMappings`), with two automatic triggers in addition to manual sync:

- **Real-time:** `bookmarkListeners.ts` listens to `bookmarks.onCreated/onRemoved/onChanged/onMoved`. Each handler runs cheap relevance guards and, if relevant, arms an 800 ms trailing-debounce timer (`scheduleReconcile`) that dynamically `import('./syncManager')` and calls `reconcileAllMappings()`. The trigger passes **no event payload to reconcile** — reconcile re-derives everything from the diff. A burst (bulk import, multi-drag) collapses into one pass.
- **Periodic:** the `raindrop-sync-interval` alarm (configurable 1–60 min) calls the same `reconcileAllMappings()`, catching up either direction — including anything a real-time trigger missed (e.g. the MV3 SW died before the debounce fired).

**`reconcileAllMappings` is the core.** For every `BookmarkLink` (the baseline) it compares the browser side and the Raindrop side against the last-synced `contentHash`/`mappingId` and derives a direction via the pure decision module `reconcile.ts` (`decideBookmarkAction`): push / pull / delete-in-raindrop / delete-in-browser / drop-link; both-changed → Raindrop wins. Bookmarks without a baseline enter union phases that create/adopt by URL rather than delete.

Folder structure is handled separately: deletion propagation runs before `reconcileFolderTree`, which mirrors nested folders/collections up to `MAX_SYNC_DEPTH`. `syncFolderWithChildren` is a wrapper around that tree walk. **Current limitation:** `decideRenameAction` is applied to mapped child collections during the walk, not to the root folder/collection pair itself.

`performFullResync` clears bookmark links and calls the global reconcile to rebuild them by union. **This is not a non-destructive mode:** existing folder mappings remain, and folder/collection deletion propagation still runs and can cascade to their contents.

### Loop prevention (the central design problem)

Sync writes bookmarks, which fire bookmark events, which would trigger more reconciles — an infinite loop. Defenses, all of which must be preserved when editing sync code:

- `setSyncing(true/false)` in `bookmarkListeners.ts` maintains a **depth counter** (`syncDepth`, not a boolean — handles concurrent syncs). All event handlers bail early when `isSyncInProgress()`. `reconcileAllMappings` wraps its body in `setSyncing(true)` … `finally setSyncing(false)`.
- **Baseline idempotency**: reconcile decisions compare each side to the `BookmarkLink` baseline, so once a pass has written both sides and updated the baseline, a re-run computes `none` for everything — a self-triggered event finds nothing to do.
- **Content hashing** (`utils/hash.ts`): `computeBookmarkHash`/`computeRaindropHash` over normalized-URL + title. Changes are skipped when the hash is unchanged. `normalizeUrl` strips tracking params, sorts query params, lowercases host — so trivially different URLs match.
- **URL-level dedup** in reconcile's union phases: an unlinked raindrop whose normalized URL is already linked under any mapping is skipped, and browser-only bookmarks are adopted by URL before creating a new raindrop. This stops the create→event→duplicate-raindrop feedback loop.
- **Teardown cancels pending timers**: `unregisterBookmarkListeners()` removes listeners and clears an armed `scheduleReconcile` timer. Preserve this cleanup on disable/disconnect. **Current limitation:** it does not cancel or await a running reconcile, and an already-running event handler can still schedule work after teardown. Disconnect resets storage without waiting for these operations, so later writes remain possible. `reconcileAllMappings` has **no** `enabled` gate by design — automatic triggers check the toggle, while manual Sync Now deliberately bypasses it.

### State model

`BookmarkLink` (in storage) is the join record tying a `firefoxId` ↔ a `raindropId`, with the last-synced `contentHash` and `mappingId`. Sync is fundamentally "reconcile browser bookmarks, raindrops, and the link table." A `FolderMapping` pairs one browser folder with one Raindrop collection. **Raindrop.io is the source of truth** on conflict.

`storage.ts` wraps `browser.storage.local`; its `StorageLock` (using `async-mutex`'s `runExclusive`) serializes bookmark-link mutations and `resetLocalState()`, not every storage write. Use its exported helpers for extension-owned settings, mappings, links, stats, errors, and tokens. `syncManager.ts` accesses `storage.local` directly for the transient `reconcile_lock`. Keys/types/defaults are in `src/types/storage.ts`.

`raindropApi.ts` is the only file that talks to `api.raindrop.io`. HTTP goes through a module-level [`ky`](https://github.com/sindresorhus/ky) instance that handles 429 + `Retry-After`, 5xx exponential backoff and network-error retry (max 3, `Retry-After` capped at 120 s); a custom `RateLimiter` (120 req/min sliding window) runs as a `beforeRequest` hook. The token is fetched in `apiRequest` **before** the ky call (so a missing token fails fast rather than being retried), and 401 auto-clears the token. Auth is a Raindrop **Test Token** (not OAuth) stored in local storage. Use its bulk helpers (`createRaindrops`, `getAllRaindropsInCollection`) rather than looping single calls.

### MV3 service-worker constraints

Chrome kills the background service worker when idle, so:

- Bookmark, message, and alarm listeners are registered at the **top level** of `index.ts` (module load), and `initialize()` is called there — listeners added only inside an async callback could be lost on SW restart.
- Keep periodic work on the **`raindrop-sync-interval` alarm**, rather than `setInterval`. The one-shot debounce timer can be lost on worker termination; later periodic reconciles re-read both sides to catch up while auto-sync remains enabled.
- Keep returning the message handler's Promise so `webextension-polyfill` can deliver the asynchronous response. The alarm listener also returns a Promise, but Chrome's `alarms.onAlarm` does not use that return value as a keep-alive mechanism. **Do not assume an entire reconcile is guaranteed to finish before worker termination.**
- `reconcile_lock` is a best-effort timestamp guard stored directly by `syncManager.ts` in `storage.local`, so it survives worker restarts and expires after five minutes. **Current limitations:** acquisition uses separate reads/writes rather than an atomic operation, and the timestamp is not renewed. Concurrent callers can both acquire it, or a long-running pass can outlive it; it does not guarantee exclusive execution.
- Alarm creation checks for an existing alarm first, to avoid resetting the timer on every SW wake-up.

## Conventions

- Import `browser` from `webextension-polyfill`; the webpack `ProvidePlugin` also injects it globally. Never use `chrome.*`.
- Use `logger` (`src/utils/logger.ts`) for new logging. Only `logger.debug` is gated by `debugMode`; `info`, `warn`, and `error` always log and enter the in-memory history exposed via `getLogHistory`.
- IDs via `generateId()` (nanoid). `tsconfig` is `strict`.
- Existing message cases often use `await import('./storage')`; this does not defer the module's initial loading because `index.ts` and `syncManager.ts` also import it statically. The dynamic `import('./syncManager')` in `bookmarkListeners.ts` serves a different purpose: breaking the static module cycle.
