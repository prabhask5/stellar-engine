/// <reference lib="webworker" />
/**
 * @fileoverview Service Worker for the PWA.
 *
 * Implements a **smart caching strategy** designed for SvelteKit's output:
 *
 *   - **Immutable assets** (`/_app/immutable/*`) — cache-first, never
 *     revalidate. These files have content-hashes in their filenames, so a
 *     new hash === a new file. Stored in a persistent `ASSET_CACHE` that
 *     survives across deploys.
 *
 *   - **Shell / static assets** — cache-first, versioned per deploy.
 *     Stored in `SHELL_CACHE` which is keyed by `APP_VERSION` and
 *     automatically cleaned up when a new SW activates.
 *
 *   - **Navigation requests** (HTML) — network-first with a 3-second
 *     timeout, falling back to the cached root `/` document. Ensures the
 *     app loads offline while staying fresh when online.
 *
 *   - **Background precaching** — after install, the SW can be told to
 *     fetch all assets listed in `asset-manifest.json`, downloading only
 *     those not already in cache. This makes the entire app available
 *     offline without blocking the install event.
 *
 * The `APP_VERSION` constant is patched automatically by the stellarPWA
 * Vite plugin on every production build.
 *
 * @see {@link handleNavigationRequest} for HTML page caching (network-first)
 * @see {@link handleImmutableAsset} for content-hashed asset caching (cache-first)
 * @see {@link handleStaticAsset} for general static asset caching (cache-first)
 * @see {@link backgroundPrecache} for offline-readiness precaching
 * @see {@link cleanupOldAssets} for stale immutable asset removal
 */
// =============================================================================
//                              VERSIONING
// =============================================================================
/**
 * Build-stamped version string — updated automatically by the stellarPWA
 * Vite plugin on each build. Used to key the shell cache and reported
 * back to clients via the `GET_VERSION` message handler.
 */
const APP_VERSION = '__SW_VERSION__';
// =============================================================================
//                            CACHE NAMING
// =============================================================================
/**
 * Persistent cache for immutable assets (`/_app/immutable/*`).
 * These files contain content hashes in their filenames, making them safe
 * to cache indefinitely. NOT cleared on deploy — assets accumulate across
 * builds and are pruned by {@link cleanupOldAssets} when triggered.
 */
const ASSET_CACHE = '__SW_PREFIX__-assets-v1';
/**
 * Versioned cache for the app shell (HTML, manifest, icons) and other
 * static assets. Re-created on each deploy; old versions are deleted
 * during the `activate` event so only one shell cache exists at a time.
 */
const SHELL_CACHE = '__SW_PREFIX__-shell-' + APP_VERSION;
// =============================================================================
//                         PRECACHE MANIFEST
// =============================================================================
/**
 * Core app shell resources to precache during the `install` event.
 * These are the minimum files needed for the app to render offline.
 *
 * Note: The root HTML (`/`) is cached separately in the install handler
 * because its failure should abort the installation entirely.
 */
const PRECACHE_ASSETS = [
    '/manifest.json',
    '/favicon.png',
    '/icon-192.png',
    '/icon-512.png',
    '/offline.html'
];
// =============================================================================
//                          INSTALL EVENT
// =============================================================================
/**
 * Install handler — precaches the minimal app shell.
 *
 * **Strategy:**
 *   1. The root HTML (`/`) is **required** — if it fails, install fails.
 *      Better to stay on the working old SW than activate with no cached HTML.
 *   2. Other shell assets (icons, manifest) are **optional** — failures
 *      are logged but don't block installation.
 *   3. Notifies all open windows via `postMessage` so the UI can show an
 *      "update available" prompt.
 *   4. Auto-promotes via `skipWaiting()` after 5 minutes as a fallback for
 *      iOS PWA where the update prompt may never be interacted with.
 *
 * @param event - The `install` {@link ExtendableEvent}.
 */
self.addEventListener('install', (event) => {
    console.log(`[SW] Installing version: ${APP_VERSION}`);
    event.waitUntil(caches.open(SHELL_CACHE).then(async (cache) => {
        /* Root HTML is REQUIRED — if it fails, install fails */
        await cache.add('/');
        console.log('[SW] Root HTML precached');
        /* Other shell assets are optional — use allSettled so failures don't block */
        await Promise.allSettled(PRECACHE_ASSETS.map((url) => cache.add(url).catch((err) => console.warn(`[SW] Failed to precache ${url}:`, err))));
        console.log('[SW] Minimal precache complete');
        /* Notify all open clients that a new version has been installed */
        self.clients.matchAll({ type: 'window' }).then((clients) => {
            clients.forEach((client) => {
                client.postMessage({ type: 'SW_INSTALLED', version: APP_VERSION });
            });
        });
    }));
    /*
     * Let the UpdatePrompt component control the transition if the user is
     * active, but auto-promote after 5 minutes to handle iOS PWA where the
     * prompt may never show (the app might be backgrounded indefinitely).
     */
    setTimeout(() => {
        self.skipWaiting();
    }, 5 * 60 * 1000);
});
// =============================================================================
//                         ACTIVATE EVENT
// =============================================================================
/**
 * Activate handler — cleans up stale caches and claims all clients.
 *
 * **Deletes:**
 *   - Old versioned shell caches (e.g., `__SW_PREFIX__-shell-<old-version>`)
 *   - The legacy `__SW_PREFIX__-cache-v1` cache (one-time migration from the
 *     original single-cache strategy)
 *
 * **Keeps:**
 *   - `ASSET_CACHE` — immutable assets persist across versions
 *   - `SHELL_CACHE` — the current deploy's shell cache
 *
 * @param event - The `activate` {@link ExtendableEvent}.
 */
self.addEventListener('activate', (event) => {
    console.log(`[SW] Activating version: ${APP_VERSION}`);
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames
            .filter((name) => {
            /* Delete old versioned shell caches (not the current one) */
            if (name.startsWith('__SW_PREFIX__-shell-') && name !== SHELL_CACHE)
                return true;
            /* Delete legacy shared cache (one-time migration) */
            if (name === '__SW_PREFIX__-cache-v1')
                return true;
            return false;
        })
            .map((name) => {
            console.log(`[SW] Deleting old cache: ${name}`);
            return caches.delete(name);
        }));
        /* Keep ASSET_CACHE — immutable assets persist across versions */
        /* Take control of all open tabs immediately */
        await self.clients.claim();
    })());
});
// =============================================================================
//                          FETCH EVENT
// =============================================================================
/**
 * Fetch handler — routes requests to the appropriate caching strategy.
 *
 * **Routing logic** (in priority order):
 *   1. Skip non-GET requests (mutations should always hit the network)
 *   2. Skip external origins (only cache same-origin resources)
 *   3. Skip `/api/*` routes (backend data — never cache)
 *   4. Navigation requests  --> {@link handleNavigationRequest} (network-first)
 *   5. Immutable assets     --> {@link handleImmutableAsset}    (cache-first, permanent)
 *   6. Static assets        --> {@link handleStaticAsset}       (cache-first)
 *   7. Everything else      --> {@link handleOtherRequest}      (network-first)
 *
 * @param event - The {@link FetchEvent} to handle.
 */
self.addEventListener('fetch', (event) => {
    /* Only intercept GET requests — let POST/PUT/DELETE go straight to network */
    if (event.request.method !== 'GET')
        return;
    const url = new URL(event.request.url);
    /* Skip external requests — we only cache same-origin resources */
    if (url.origin !== self.location.origin)
        return;
    /* Skip API routes — backend data must always be fresh */
    if (url.pathname.startsWith('/api/'))
        return;
    /* ── Navigation Requests (HTML pages) ───────────────────────────── */
    if (event.request.mode === 'navigate') {
        event.respondWith(handleNavigationRequest(event.request));
        return;
    }
    /* ── Immutable Assets (`/_app/immutable/*`) ─────────────────────── */
    /* Content-hashed filenames → cache forever, never revalidate        */
    if (url.pathname.includes('/_app/immutable/')) {
        event.respondWith(handleImmutableAsset(event.request));
        return;
    }
    /* ── Other Static Assets (JS, CSS, images, fonts, JSON) ─────────── */
    if (isStaticAsset(url.pathname)) {
        event.respondWith(handleStaticAsset(event.request));
        return;
    }
    /* ── Fallback — network-first for everything else ───────────────── */
    event.respondWith(handleOtherRequest(event.request));
});
// =============================================================================
//                         HELPER: STATIC ASSET CHECK
// =============================================================================
/**
 * Determines whether a given pathname looks like a static asset
 * (scripts, styles, images, fonts, data files).
 *
 * Matches by file extension or by the `/_app/` prefix (SvelteKit's
 * client-side output directory).
 *
 * @param pathname - The URL pathname to test (e.g., `/_app/version.json`).
 * @returns `true` if the path matches a known static-asset extension.
 *
 * @example
 * ```ts
 * isStaticAsset('/icon-192.png');  // true
 * isStaticAsset('/api/config');    // false
 * ```
 */
function isStaticAsset(pathname) {
    return (pathname.startsWith('/_app/') ||
        pathname.endsWith('.js') ||
        pathname.endsWith('.css') ||
        pathname.endsWith('.png') ||
        pathname.endsWith('.jpg') ||
        pathname.endsWith('.jpeg') ||
        pathname.endsWith('.gif') ||
        pathname.endsWith('.svg') ||
        pathname.endsWith('.ico') ||
        pathname.endsWith('.woff') ||
        pathname.endsWith('.woff2') ||
        pathname.endsWith('.json') ||
        pathname.endsWith('.webp'));
}
// =============================================================================
//                    STRATEGY: NAVIGATION (NETWORK-FIRST)
// =============================================================================
/**
 * Handles HTML navigation requests with a **network-first** strategy.
 *
 * **Flow:**
 *   1. Attempt a network fetch with a 3-second timeout (abort via `AbortController`)
 *   2. If successful --> cache the response as `/` and return it
 *   3. If failed --> serve the cached root HTML for offline use
 *   4. If nothing cached --> return a minimal offline fallback page
 *
 * The 3-second timeout prevents the user from staring at a blank screen
 * on flaky connections while still preferring fresh content.
 *
 * @param request - The navigation `Request` object.
 * @returns A `Response` (from network, cache, or inline fallback).
 */
async function handleNavigationRequest(request) {
    const cache = await caches.open(SHELL_CACHE);
    try {
        /* 3-second timeout — don't leave the user staring at a blank screen */
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(request, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (response.ok) {
            /* Cache the fresh HTML for offline fallback */
            cache.put('/', response.clone());
            return response;
        }
        throw new Error('Network response not ok');
    }
    catch {
        /* Network failed or timed out — serve cached HTML */
        console.log('[SW] Navigation offline, serving cache');
        const cached = await cache.match('/');
        if (cached)
            return cached;
        /* Try custom offline page (projects can create static/offline.html) */
        const offlinePage = await cache.match('/offline.html');
        if (offlinePage)
            return offlinePage;
        /* Last resort — minimal inline offline page */
        return new Response(getOfflineHTML(), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }
}
// =============================================================================
//              STRATEGY: IMMUTABLE ASSETS (CACHE-FIRST, PERMANENT)
// =============================================================================
/**
 * Handles requests for immutable assets (`/_app/immutable/*`).
 *
 * **Strategy:** cache-first, NEVER revalidate. These files have content
 * hashes baked into their filenames — if the content changes, the filename
 * changes, so a cached version is always correct.
 *
 * Uses `ASSET_CACHE` which persists across SW versions (not cleared on
 * deploy). Old entries are pruned by {@link cleanupOldAssets}.
 *
 * @param request - The `Request` for an immutable asset.
 * @returns The cached `Response`, or a freshly-fetched one (then cached).
 */
async function handleImmutableAsset(request) {
    const cache = await caches.open(ASSET_CACHE);
    /* Check cache first — if we have it, it's guaranteed correct */
    const cached = await cache.match(request);
    if (cached) {
        return cached;
    }
    /* Not cached yet — fetch from network and cache for next time */
    try {
        const response = await fetch(request);
        if (response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    }
    catch {
        console.error('[SW] Failed to fetch immutable:', request.url);
        return new Response('Asset not available offline', { status: 503 });
    }
}
// =============================================================================
//                STRATEGY: STATIC ASSETS (CACHE-FIRST)
// =============================================================================
/**
 * Handles requests for general static assets (non-immutable JS, CSS, images,
 * fonts, JSON files).
 *
 * **Strategy:** cache-first, NO background revalidation. This saves
 * bandwidth — the shell cache is versioned per deploy, so stale assets
 * are cleaned up automatically when the new SW activates.
 *
 * @param request - The `Request` for a static asset.
 * @returns The cached `Response`, or a freshly-fetched one (then cached).
 */
async function handleStaticAsset(request) {
    const cache = await caches.open(SHELL_CACHE);
    /* Check cache first — return immediately, no background fetch */
    const cached = await cache.match(request);
    if (cached) {
        return cached;
    }
    /* Not cached — fetch and store */
    try {
        const response = await fetch(request);
        if (response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    }
    catch {
        console.log('[SW] Static asset fetch failed:', request.url);
        return new Response('Asset not available offline', { status: 503 });
    }
}
// =============================================================================
//               STRATEGY: OTHER REQUESTS (NETWORK-FIRST)
// =============================================================================
/**
 * Handles all other same-origin GET requests with a **network-first** strategy.
 *
 * **Flow:**
 *   1. Try the network
 *   2. If successful --> cache and return
 *   3. If failed --> return cached version
 *   4. If nothing cached --> return a 503 "Offline" response
 *
 * @param request - The `Request` object.
 * @returns A `Response` from network or cache.
 */
async function handleOtherRequest(request) {
    const cache = await caches.open(SHELL_CACHE);
    try {
        const response = await fetch(request);
        if (response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    }
    catch {
        const cached = await cache.match(request);
        if (cached)
            return cached;
        return new Response('Offline', { status: 503 });
    }
}
// =============================================================================
//                       BACKGROUND PRECACHING
// =============================================================================
/**
 * Downloads all assets listed in `asset-manifest.json` that are NOT already
 * cached. This makes the entire app available offline without blocking the
 * install event.
 *
 * **Key behaviours:**
 *   - Fetches the manifest with a cache-busting query param (`?_=<timestamp>`)
 *   - Checks both `ASSET_CACHE` and `SHELL_CACHE` to avoid redundant downloads
 *   - Downloads in batches of 5 with a 50 ms pause between batches to avoid
 *     saturating the network
 *   - Notifies all open windows with `PRECACHE_COMPLETE` when done
 *
 * Triggered by sending `{ type: 'PRECACHE_ALL' }` to the service worker.
 *
 * @returns A promise that resolves when precaching is complete (or fails).
 *
 * @see {@link cleanupOldAssets} for removing assets no longer in the manifest
 */
async function backgroundPrecache() {
    try {
        const assetCache = await caches.open(ASSET_CACHE);
        const shellCache = await caches.open(SHELL_CACHE);
        /* Fetch manifest with cache-bust to ensure we get the latest version */
        const manifestResponse = await fetch('/asset-manifest.json?_=' + Date.now(), {
            cache: 'no-store'
        });
        if (!manifestResponse.ok) {
            console.warn('[SW] Asset manifest not found');
            return;
        }
        const manifest = await manifestResponse.json();
        const assets = manifest.assets || [];
        if (assets.length === 0) {
            console.warn('[SW] Asset manifest empty');
            return;
        }
        /* ── Determine which assets still need caching ────────────────── */
        const uncached = [];
        for (const url of assets) {
            /* Route to the correct cache based on whether the asset is immutable */
            const isImmutable = url.includes('/_app/immutable/');
            const cache = isImmutable ? assetCache : shellCache;
            const cached = await cache.match(url);
            if (!cached) {
                uncached.push(url);
            }
        }
        if (uncached.length === 0) {
            console.log('[SW] All assets already cached - full offline ready');
            notifyClients({ type: 'PRECACHE_COMPLETE', cached: assets.length, total: assets.length });
            return;
        }
        console.log(`[SW] Caching ${uncached.length} new assets (${assets.length - uncached.length} already cached)`);
        /* ── Download in batches to avoid network saturation ──────────── */
        let successCount = 0;
        const batchSize = 5;
        for (let i = 0; i < uncached.length; i += batchSize) {
            const batch = uncached.slice(i, i + batchSize);
            const results = await Promise.allSettled(batch.map((url) => {
                const isImmutable = url.includes('/_app/immutable/');
                const cache = isImmutable ? assetCache : shellCache;
                return cache.add(url);
            }));
            results.forEach((r, idx) => {
                if (r.status === 'fulfilled')
                    successCount++;
                else
                    console.warn(`[SW] Failed to cache: ${batch[idx]}`);
            });
            /* Small delay between batches to be polite to the network */
            if (i + batchSize < uncached.length) {
                await new Promise((r) => setTimeout(r, 50));
            }
        }
        const totalCached = assets.length - uncached.length + successCount;
        console.log(`[SW] Precache complete: ${totalCached}/${assets.length}`);
        notifyClients({ type: 'PRECACHE_COMPLETE', cached: totalCached, total: assets.length });
    }
    catch (e) {
        console.warn('[SW] Precache error:', e);
    }
}
// =============================================================================
//                     OLD ASSET CLEANUP
// =============================================================================
/**
 * Removes stale immutable assets from `ASSET_CACHE` that are no longer
 * referenced in the current `asset-manifest.json`.
 *
 * Only targets `/_app/immutable/*` entries — the shell cache is already
 * versioned and cleaned during the `activate` event.
 *
 * Triggered by sending `{ type: 'CLEANUP_OLD' }` to the service worker.
 *
 * @returns A promise that resolves when cleanup is complete.
 */
async function cleanupOldAssets() {
    try {
        const cache = await caches.open(ASSET_CACHE);
        /* Fetch the current manifest to know which assets are still valid */
        const manifestResponse = await fetch('/asset-manifest.json', { cache: 'no-store' });
        if (!manifestResponse.ok)
            return;
        const manifest = await manifestResponse.json();
        const currentAssets = new Set(manifest.assets || []);
        /* Walk cached entries and delete any that aren't in the manifest */
        const cachedRequests = await cache.keys();
        let deletedCount = 0;
        for (const request of cachedRequests) {
            const url = new URL(request.url);
            const pathname = url.pathname;
            /* Only clean up immutable assets that are no longer referenced */
            if (pathname.includes('/_app/immutable/') && !currentAssets.has(pathname)) {
                await cache.delete(request);
                deletedCount++;
            }
        }
        if (deletedCount > 0) {
            console.log(`[SW] Cleaned up ${deletedCount} old assets`);
        }
    }
    catch (e) {
        console.warn('[SW] Cleanup error:', e);
    }
}
// =============================================================================
//                         CLIENT COMMUNICATION
// =============================================================================
/**
 * Broadcasts a message to all open windows/tabs.
 *
 * @param message - The message object to send (e.g., `{ type: 'PRECACHE_COMPLETE', ... }`).
 *
 * @example
 * ```ts
 * notifyClients({ type: 'PRECACHE_COMPLETE', cached: 42, total: 50 });
 * ```
 */
function notifyClients(message) {
    self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => client.postMessage(message));
    });
}
// =============================================================================
//                       OFFLINE FALLBACK PAGE
// =============================================================================
/**
 * Returns a minimal offline fallback HTML page. This is only used as a
 * last resort when no cached HTML or custom `/offline.html` is available.
 *
 * Projects should create their own `static/offline.html` with custom
 * styling — it will be precached and served automatically instead of
 * this bare-bones fallback.
 *
 * @returns An unstyled HTML string for the offline fallback.
 */
function getOfflineHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Offline - __SW_NAME__</title>
</head>
<body>
  <h1>You're Offline</h1>
  <p>Please check your internet connection and try again.</p>
  <button onclick="location.reload()">Try Again</button>
</body>
</html>`;
}
// =============================================================================
//                        MESSAGE HANDLER
// =============================================================================
/**
 * Listens for messages from the app's client-side code.
 *
 * **Supported message types:**
 *   - `SKIP_WAITING`     --> Immediately activate the waiting SW (user accepted update)
 *   - `GET_VERSION`      --> Responds with the current `APP_VERSION` via `MessagePort`
 *   - `PRECACHE_ALL`     --> Triggers {@link backgroundPrecache} to download all assets
 *   - `CLEANUP_OLD`      --> Triggers {@link cleanupOldAssets} to remove stale cache entries
 *   - `CACHE_URLS`       --> Caches a specific list of URLs (used for route prefetching)
 *   - `GET_CACHE_STATUS` --> Responds with cache completeness info via `MessagePort`
 *
 * @param event - The {@link ExtendableMessageEvent} from a client.
 */
self.addEventListener('message', (event) => {
    const { type } = event.data || {};
    /* ── Force-activate the waiting service worker ──────────────────── */
    if (type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    /* ── Return the current build version ───────────────────────────── */
    if (type === 'GET_VERSION') {
        event.ports[0]?.postMessage({ version: APP_VERSION });
    }
    /* ── Trigger background precache of all manifest assets ─────────── */
    if (type === 'PRECACHE_ALL') {
        backgroundPrecache();
    }
    /* ── Trigger cleanup of stale immutable assets ──────────────────── */
    if (type === 'CLEANUP_OLD') {
        cleanupOldAssets();
    }
    /* ── Cache specific URLs on demand (e.g., route prefetching) ────── */
    if (type === 'CACHE_URLS') {
        const urls = event.data.urls || [];
        const assetCachePromise = caches.open(ASSET_CACHE);
        const shellCachePromise = caches.open(SHELL_CACHE);
        Promise.all([assetCachePromise, shellCachePromise]).then(([ac, sc]) => {
            urls.forEach((url) => {
                /* Route each URL to the correct cache based on immutability */
                const isImmutable = url.includes('/_app/immutable/');
                const cache = isImmutable ? ac : sc;
                cache.add(url).catch(() => { });
            });
        });
    }
    /* ── Report how many assets are cached vs. total ────────────────── */
    if (type === 'GET_CACHE_STATUS') {
        getCacheStatus().then((status) => {
            event.ports[0]?.postMessage(status);
        });
    }
});
// =============================================================================
//                        CACHE STATUS REPORTER
// =============================================================================
/**
 * Computes the current cache completeness by comparing cached entries
 * against the asset manifest.
 *
 * Attempts to find the manifest in cache first (for offline use), then
 * falls back to a network fetch.
 *
 * @returns An object describing cache readiness:
 *   - `cached`  — Number of manifest assets currently in cache
 *   - `total`   — Total number of assets in the manifest
 *   - `ready`   — `true` if every asset is cached (full offline support)
 *   - `version` — The manifest version string (if available)
 *   - `error`   — Error message string (only present if something went wrong)
 */
async function getCacheStatus() {
    try {
        const assetCache = await caches.open(ASSET_CACHE);
        const shellCache = await caches.open(SHELL_CACHE);
        /* Try to find the manifest in cache first, then fall back to network */
        const manifestResponse = (await shellCache.match('/asset-manifest.json')) ||
            (await assetCache.match('/asset-manifest.json')) ||
            (await fetch('/asset-manifest.json').catch(() => null));
        if (!manifestResponse) {
            return { cached: 0, total: 0, ready: false };
        }
        const manifest = await manifestResponse.clone().json();
        const assets = manifest.assets || [];
        /* Count how many manifest entries are already cached */
        let cachedCount = 0;
        for (const url of assets) {
            const isImmutable = url.includes('/_app/immutable/');
            const cache = isImmutable ? assetCache : shellCache;
            if (await cache.match(url))
                cachedCount++;
        }
        return {
            cached: cachedCount,
            total: assets.length,
            ready: cachedCount === assets.length,
            version: manifest.version
        };
    }
    catch (e) {
        return { cached: 0, total: 0, ready: false, error: e.message };
    }
}
export {};
