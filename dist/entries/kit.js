// Kit subpath barrel – @prabhask5/stellar-engine/kit
// SvelteKit route helpers: server APIs, load functions, confirmation, SW lifecycle, auth hydration
export { getServerConfig, deployToVercel, createValidateHandler } from '../kit/server.js';
export { resolveRootLayout, resolveProtectedLayout, resolveSetupAccess } from '../kit/loads.js';
export { handleEmailConfirmation, broadcastAuthConfirmed } from '../kit/confirm.js';
export { pollForNewServiceWorker, handleSwUpdate, monitorSwLifecycle } from '../kit/sw.js';
export { hydrateAuthState } from '../kit/auth.js';
//# sourceMappingURL=kit.js.map