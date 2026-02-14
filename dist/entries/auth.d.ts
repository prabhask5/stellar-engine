/**
 * @fileoverview Auth subpath barrel — `@prabhask5/stellar-engine/auth`
 *
 * Consolidates all authentication-related exports into a single entry point.
 * Covers four authentication strategies:
 *
 * 1. **Supabase Auth** — standard email/password sign-in, sign-up, OTP, and
 *    profile management via Supabase GoTrue.
 * 2. **Auth State Resolution** — determines the current auth state on app load
 *    (authenticated, anonymous, expired session, etc.).
 * 3. **Admin** — role-based admin check utility.
 * 4. **Offline Login** — allows cached credential login when the device is offline.
 * 5. **Single-User Auth** — PIN/password gate for single-user (kiosk-style) apps
 *    with device linking and remote configuration.
 */
export { signIn, signUp, signOut, changePassword, changeEmail, completeEmailChange, resendConfirmationEmail, getUserProfile, updateProfile, verifyOtp, getValidSession } from '../supabase/auth';
export type { AuthResponse } from '../supabase/auth';
export { resolveAuthState } from '../auth/resolveAuthState';
export type { AuthStateResult } from '../auth/resolveAuthState';
export { isAdmin } from '../auth/admin';
export { signInOffline, getOfflineLoginInfo } from '../auth/offlineLogin';
export { resolveFirstName, resolveUserId, resolveAvatarInitial } from '../auth/displayUtils';
export { isSingleUserSetUp, getSingleUserInfo, setupSingleUser, unlockSingleUser, lockSingleUser, changeSingleUserGate, updateSingleUserProfile, resetSingleUser, completeSingleUserSetup, completeDeviceVerification, pollDeviceVerification, padPin, changeSingleUserEmail, completeSingleUserEmailChange, fetchRemoteGateConfig, linkSingleUserDevice, resetSingleUserRemote } from '../auth/singleUser';
//# sourceMappingURL=auth.d.ts.map