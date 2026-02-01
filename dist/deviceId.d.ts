/**
 * Device ID Management
 *
 * Generates and persists a stable device identifier for deterministic conflict resolution.
 * When two operations have the same timestamp, the device ID is used as a tiebreaker
 * to ensure consistent resolution across all devices.
 */
export declare function _setDeviceIdPrefix(prefix: string): void;
/**
 * Get or create a stable device ID for this browser/device.
 * The ID is stored in localStorage and persists across sessions.
 *
 * Format: Random UUID v4
 */
export declare function getDeviceId(): string;
//# sourceMappingURL=deviceId.d.ts.map