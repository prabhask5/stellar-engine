/**
 * Device ID Management
 *
 * Generates and persists a stable device identifier for deterministic conflict resolution.
 * When two operations have the same timestamp, the device ID is used as a tiebreaker
 * to ensure consistent resolution across all devices.
 */
let _deviceIdPrefix = 'stellar';
export function _setDeviceIdPrefix(prefix) {
    _deviceIdPrefix = prefix;
}
function getDeviceIdKey() {
    return `${_deviceIdPrefix}_device_id`;
}
/**
 * Get or create a stable device ID for this browser/device.
 * The ID is stored in localStorage and persists across sessions.
 *
 * Format: Random UUID v4
 */
export function getDeviceId() {
    if (typeof localStorage === 'undefined') {
        // SSR context - return a placeholder that won't be used
        return 'ssr-placeholder';
    }
    let deviceId = localStorage.getItem(getDeviceIdKey());
    if (!deviceId) {
        deviceId = generateUUID();
        localStorage.setItem(getDeviceIdKey(), deviceId);
    }
    return deviceId;
}
/**
 * Generate a UUID v4 (random UUID).
 * Uses crypto.randomUUID if available, otherwise falls back to manual generation.
 */
function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // Fallback for older browsers
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
/**
 * Reset the device ID (for testing purposes).
 * In production, this should rarely be called.
 */
export function resetDeviceId() {
    if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(getDeviceIdKey());
    }
}
//# sourceMappingURL=deviceId.js.map