# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Session start protocol (read first)

This project tracks ongoing work in a local, gitignored `.ai/` folder so sessions are resumable across context resets. At the start of any work session:

1. Read `.ai/STATE.md` — current focus, where the last session stopped, next step.
2. Read `.ai/PLAN.md` for the roadmap, then open the active `.ai/tasks/NNN-*.md` named in STATE.
3. Work from the task's `Steps` checklist.

While working, keep `.ai/` as the source of truth — not the chat:
- Tick checkboxes in the task file as steps land; record any decision that affects code in the task's `Notes` (or `.ai/log/YYYY-MM-DD.md`).
- **Before stopping (or when context runs low), update `.ai/STATE.md`** so a fresh session can resume seamlessly. Fix often, in small increments — not one big dump at the end.

See `.ai/README.md` for the full convention.

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

Two-way sync flows through two distinct paths:

- **Browser → Raindrop (push):** `bookmarkListeners.ts` listens to `bookmarks.onCreated/onRemoved/onChanged/onMoved`, builds a `SyncOperation`, and enqueues it. `queue.ts` (`queueProcessor`) drains the queue and calls the Raindrop API. Real-time.
- **Raindrop → Browser (pull):** `syncManager.ts:pullFromRaindrop` runs on an alarm (`raindrop-sync-interval`, configurable 1–60 min), diffs each collection against local state, and creates/updates/deletes browser bookmarks. Polling.

**`syncManager.ts` is the core.** It owns initial sync (URL-matching existing bookmarks ↔ raindrops), pull/push diffing, nested-folder mirroring (`syncFolderWithChildren`, creates Raindrop collections to match folder trees, depth-capped at `MAX_SYNC_DEPTH`), and full re-sync.

### Loop prevention (the central design problem)

Sync writes bookmarks, which fire bookmark events, which would enqueue more sync operations — an infinite loop. Defenses, all of which must be preserved when editing sync code:

- `setSyncing(true/false)` in `bookmarkListeners.ts` maintains a **depth counter** (`syncDepth`, not a boolean — handles concurrent syncs). All event handlers bail early when `isSyncInProgress()`. Every sync function wraps its body in `setSyncing(true)` … `finally setSyncing(false)`.
- **Content hashing** (`utils/hash.ts`): `computeBookmarkHash`/`computeRaindropHash` over normalized-URL + title. Changes are skipped when the hash is unchanged. `normalizeUrl` strips tracking params, sorts query params, lowercases host — so trivially different URLs match.
- **URL-level dedup in pull** (`pullSyncForMapping`): if an incoming raindrop's normalized URL is already linked under any mapping, it's skipped even if the raindrop `_id` is new. This stops the create→event→duplicate-raindrop→pull-sees-new feedback loop.
- Queue create/pull handlers re-check for an existing `BookmarkLink` before acting.

### State model

`BookmarkLink` (in storage) is the join record tying a `firefoxId` ↔ a `raindropId`, with the last-synced `contentHash` and `mappingId`. Sync is fundamentally "reconcile browser bookmarks, raindrops, and the link table." A `FolderMapping` pairs one browser folder with one Raindrop collection. **Raindrop.io is the source of truth** on conflict.

`storage.ts` wraps `browser.storage.local` and serializes all writes through a `StorageLock` (promise chain) for atomicity — use its exported helpers, don't call `browser.storage.local` directly for these keys. Keys/types/defaults are in `src/types/storage.ts`.

`raindropApi.ts` is the only file that talks to `api.raindrop.io`. It has a built-in `RateLimiter` (120 req/min) plus 429/5xx/network retry with backoff, and auto-clears the token on 401. Auth is a Raindrop **Test Token** (not OAuth) stored in local storage. Use its bulk helpers (`createRaindrops`, `getAllRaindropsInCollection`) rather than looping single calls.

### MV3 service-worker constraints

Chrome kills the background service worker when idle, so:

- Bookmark listeners and `initialize()` are registered at the **top level** of `index.ts` (module load), not inside an async callback — otherwise they're lost on SW restart.
- Periodic work is driven by **alarms** (`process-queue` every 1 min, `raindrop-sync-interval` for pull), never `setInterval`. Alarm/message listeners **return the Promise** so the SW stays alive until async work finishes.
- The queue uses a stale-tolerant lock in `storage.local` (`PROCESSING_LOCK_KEY`, 5-min timeout) because an in-memory lock wouldn't survive a SW restart.
- Alarm creation checks for an existing alarm first, to avoid resetting the timer on every SW wake-up.

## Conventions

- Import `browser` from `webextension-polyfill`; the webpack `ProvidePlugin` also injects it globally. Never use `chrome.*`.
- `logger` (`utils/logger.ts`) for all logging; gated by a `debugMode` setting, keeps an in-memory history surfaced via the `getLogHistory` message.
- IDs via `generateId()` (nanoid). `tsconfig` is `strict`.
- Heavy storage helpers are pulled in with dynamic `import()` inside message cases (e.g. `await import('./storage')`) to keep the SW's initial parse light — follow that pattern when adding cases.
