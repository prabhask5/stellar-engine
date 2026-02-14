/**
 * @fileoverview Shared Cryptographic Utilities
 *
 * Provides deterministic, one-way hashing primitives used throughout the auth
 * subsystem for password storage, gate-code verification, and credential caching.
 *
 * Architecture:
 * - Uses the Web Crypto API (`crypto.subtle`) which is available in all modern
 *   browsers, Web Workers, and server-side runtimes (Node 15+, Deno, Bun).
 * - Hashing is always SHA-256, producing a 64-character lowercase hex digest.
 *   This is NOT a password-hashing algorithm (bcrypt/argon2); it is used only
 *   for **local** cache comparisons. The server-side Supabase auth layer uses
 *   bcrypt for actual credential storage.
 *
 * Security considerations:
 * - SHA-256 is collision-resistant but NOT suitable for brute-force-resistant
 *   password storage on its own. It is acceptable here because the hashed values
 *   are only stored in the client-side IndexedDB for offline pre-checking and
 *   are never transmitted to a server.
 * - The `isAlreadyHashed` helper uses a regex heuristic (64-char hex). If a
 *   user's actual password happens to be a 64-char hex string, it will be
 *   misidentified as already hashed. This is an acceptable edge case given the
 *   vanishingly low probability and the local-only usage context.
 *
 * @module auth/crypto
 */
// =============================================================================
// PUBLIC API
// =============================================================================
/**
 * Hash a value using SHA-256 via the Web Crypto API.
 *
 * Encodes the input string as UTF-8, computes the SHA-256 digest, and returns
 * the result as a 64-character lowercase hexadecimal string.
 *
 * @param value - The plaintext string to hash (e.g., a password or gate code).
 * @returns A promise that resolves to a 64-character hex string representing
 *          the SHA-256 digest.
 *
 * @example
 * ```ts
 * const hashed = await hashValue('my-secret-password');
 * // hashed === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' (example)
 * ```
 *
 * @see {@link isAlreadyHashed} to check whether a string is already a hex digest.
 */
export async function hashValue(value) {
    const encoder = new TextEncoder();
    const data = encoder.encode(value);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
/**
 * Check if a stored value is already hashed (64-character hex string).
 *
 * Used to distinguish between legacy plaintext credentials and modern
 * SHA-256-hashed credentials in IndexedDB, enabling backward-compatible
 * verification without a migration step.
 *
 * @param value - The string to test.
 * @returns `true` if the value matches the pattern of a SHA-256 hex digest
 *          (exactly 64 lowercase hexadecimal characters), `false` otherwise.
 *
 * @example
 * ```ts
 * isAlreadyHashed('abc123');           // false
 * isAlreadyHashed('e3b0c442...b855');  // true (64-char hex)
 * ```
 */
export function isAlreadyHashed(value) {
    return /^[0-9a-f]{64}$/.test(value);
}
//# sourceMappingURL=crypto.js.map