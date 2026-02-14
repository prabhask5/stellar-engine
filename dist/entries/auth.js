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
// =============================================================================
//  Supabase Auth — Core Authentication Operations
// =============================================================================
// Standard Supabase GoTrue operations: sign in/up/out, password and email
// changes, email confirmation, profile CRUD, OTP verification, and session
// validation. `AuthResponse` is the unified return type for all auth calls.
export { signIn, signUp, signOut, changePassword, changeEmail, completeEmailChange, resendConfirmationEmail, getUserProfile, updateProfile, verifyOtp, getValidSession } from '../supabase/auth';
// =============================================================================
//  Auth State Resolution
// =============================================================================
// Determines the user's authentication state during app initialization by
// checking the Supabase session, offline credentials, and single-user config.
// Returns an `AuthStateResult` describing which auth path the app should take.
export { resolveAuthState } from '../auth/resolveAuthState';
// =============================================================================
//  Admin Role Check
// =============================================================================
// Utility to check whether the current user has admin privileges, based on
// metadata stored in the Supabase user profile or local config.
export { isAdmin } from '../auth/admin';
// =============================================================================
//  Offline Login
// =============================================================================
// Enables authentication when the device has no network connectivity. Uses
// locally cached and encrypted credentials to validate the user. `signInOffline`
// performs the offline auth flow; `getOfflineLoginInfo` retrieves stored
// credential metadata for the login UI.
export { signInOffline, getOfflineLoginInfo } from '../auth/offlineLogin';
// =============================================================================
//  Single-User Auth (PIN/Password Gate)
// =============================================================================
// Full lifecycle for single-user (kiosk/personal device) authentication:
// - Setup and teardown (`setupSingleUser`, `resetSingleUser`, `completeSingleUserSetup`)
// - Lock/unlock gate (`unlockSingleUser`, `lockSingleUser`, `changeSingleUserGate`)
// - Profile management (`updateSingleUserProfile`, `changeSingleUserEmail`,
//   `completeSingleUserEmailChange`)
// - Device linking and verification (`linkSingleUserDevice`,
//   `completeDeviceVerification`, `pollDeviceVerification`)
// - Remote configuration (`fetchRemoteGateConfig`, `resetSingleUserRemote`)
// - Utility (`padPin`, `isSingleUserSetUp`, `getSingleUserInfo`)
// =============================================================================
//  Auth Display Utilities
// =============================================================================
// Pure helper functions that resolve user-facing display values from the auth
// state. Each handles the full fallback chain across online (Supabase session)
// and offline (cached credential) modes:
// - `resolveFirstName` — display name with configurable fallback.
// - `resolveUserId` — user UUID from session or offline cache.
// - `resolveAvatarInitial` — single uppercase letter for avatar circles.
export { resolveFirstName, resolveUserId, resolveAvatarInitial } from '../auth/displayUtils';
// =============================================================================
//  Single-User Auth (PIN/Password Gate)
// =============================================================================
// Full lifecycle for single-user (kiosk/personal device) authentication:
// - Setup and teardown (`setupSingleUser`, `resetSingleUser`, `completeSingleUserSetup`)
// - Lock/unlock gate (`unlockSingleUser`, `lockSingleUser`, `changeSingleUserGate`)
// - Profile management (`updateSingleUserProfile`, `changeSingleUserEmail`,
//   `completeSingleUserEmailChange`)
// - Device linking and verification (`linkSingleUserDevice`,
//   `completeDeviceVerification`, `pollDeviceVerification`)
// - Remote configuration (`fetchRemoteGateConfig`, `resetSingleUserRemote`)
// - Utility (`padPin`, `isSingleUserSetUp`, `getSingleUserInfo`)
export { isSingleUserSetUp, getSingleUserInfo, setupSingleUser, unlockSingleUser, lockSingleUser, changeSingleUserGate, updateSingleUserProfile, resetSingleUser, completeSingleUserSetup, completeDeviceVerification, pollDeviceVerification, padPin, changeSingleUserEmail, completeSingleUserEmailChange, fetchRemoteGateConfig, linkSingleUserDevice, resetSingleUserRemote } from '../auth/singleUser';
//# sourceMappingURL=auth.js.map