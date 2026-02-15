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
 */
export async function hashValue(value) {
    const encoder = new TextEncoder();
    const data = encoder.encode(value);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
//# sourceMappingURL=crypto.js.map