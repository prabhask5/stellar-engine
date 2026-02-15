/**
 * @fileoverview Auth subpath barrel — `@prabhask5/stellar-engine/auth`
 *
 * Consolidates all authentication-related exports into a single entry point
 * for the single-user PIN/password gate system:
 *
 * 1. **Auth Utilities** — sign-out with full teardown, session management,
 *    profile CRUD, OTP verification, and email confirmation.
 * 2. **Auth State Resolution** — determines the current auth state on app load.
 * 3. **Single-User Auth** — PIN/password gate for single-user (kiosk-style) apps
 *    with device linking and remote configuration.
 * 4. **Display Utilities** — resolve user-facing display values from auth state.
 */
export { signOut, resendConfirmationEmail, getUserProfile, updateProfile, verifyOtp, getValidSession } from '../supabase/auth';
export { resolveAuthState } from '../auth/resolveAuthState';
export type { AuthStateResult } from '../auth/resolveAuthState';
export { resolveFirstName, resolveUserId, resolveAvatarInitial } from '../auth/displayUtils';
export { isSingleUserSetUp, getSingleUserInfo, setupSingleUser, unlockSingleUser, lockSingleUser, changeSingleUserGate, updateSingleUserProfile, resetSingleUser, completeSingleUserSetup, completeDeviceVerification, pollDeviceVerification, padPin, changeSingleUserEmail, completeSingleUserEmailChange, fetchRemoteGateConfig, linkSingleUserDevice, resetSingleUserRemote } from '../auth/singleUser';
//# sourceMappingURL=auth.d.ts.map