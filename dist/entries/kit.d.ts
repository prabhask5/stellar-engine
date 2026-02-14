export { getServerConfig, deployToVercel, createValidateHandler } from '../kit/server.js';
export type { DeployConfig, DeployResult, ServerConfig } from '../kit/server.js';
export { resolveRootLayout, resolveProtectedLayout, resolveSetupAccess } from '../kit/loads.js';
export type { RootLayoutData, ProtectedLayoutData, SetupAccessData } from '../kit/loads.js';
export { handleEmailConfirmation, broadcastAuthConfirmed } from '../kit/confirm.js';
export type { ConfirmResult } from '../kit/confirm.js';
export { pollForNewServiceWorker, handleSwUpdate, monitorSwLifecycle } from '../kit/sw.js';
export type { PollOptions, SwLifecycleCallbacks } from '../kit/sw.js';
export { hydrateAuthState } from '../kit/auth.js';
export type { AuthLayoutData } from '../kit/auth.js';
//# sourceMappingURL=kit.d.ts.map