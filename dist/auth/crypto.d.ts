/**
 * Shared Crypto Utilities
 * SHA-256 hashing for passwords, codes, and other values.
 */
/**
 * Hash a value using SHA-256 via Web Crypto API.
 * Returns a 64-character hex string.
 */
export declare function hashValue(value: string): Promise<string>;
/**
 * Check if a stored value is already hashed (64-char hex string).
 */
export declare function isAlreadyHashed(value: string): boolean;
//# sourceMappingURL=crypto.d.ts.map