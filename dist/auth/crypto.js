/**
 * Shared Crypto Utilities
 * SHA-256 hashing for passwords, codes, and other values.
 */
/**
 * Hash a value using SHA-256 via Web Crypto API.
 * Returns a 64-character hex string.
 */
export async function hashValue(value) {
    const encoder = new TextEncoder();
    const data = encoder.encode(value);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
/**
 * Check if a stored value is already hashed (64-char hex string).
 */
export function isAlreadyHashed(value) {
    return /^[0-9a-f]{64}$/.test(value);
}
//# sourceMappingURL=crypto.js.map