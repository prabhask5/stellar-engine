/**
 * Runtime Configuration Module
 *
 * Replaces build-time $env/static/public with runtime config fetched from the server.
 * Config is cached in localStorage for instant subsequent loads and offline PWA support.
 */
export interface AppConfig {
    supabaseUrl: string;
    supabaseAnonKey: string;
    configured: boolean;
}
export declare function _setConfigPrefix(prefix: string): void;
/**
 * Initialize config: tries localStorage first (instant), then validates against server.
 * Returns the config if configured, null if not.
 */
export declare function initConfig(): Promise<AppConfig | null>;
/**
 * Get config synchronously. Returns cached config or null.
 * Call initConfig() first to ensure config is loaded.
 */
export declare function getConfig(): AppConfig | null;
/**
 * Set config directly (used after setup wizard completes)
 */
export declare function setConfig(config: AppConfig): void;
//# sourceMappingURL=runtimeConfig.d.ts.map