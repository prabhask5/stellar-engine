/**
 * @fileoverview Auth subpath barrel — `stellar-drive/auth`
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
// =============================================================================
//  Supabase Auth — Core Authentication Utilities
// =============================================================================
// Sign-out with full teardown, session management, profile CRUD, email
// confirmation resend, OTP verification, and session validation.
export { signOut, resendConfirmationEmail, getUserProfile, updateProfile, verifyOtp, getValidSession } from '../supabase/auth';
// =============================================================================
//  Auth State Resolution
// =============================================================================
// Determines the user's authentication state during app initialization by
// checking the Supabase session, offline credentials, and single-user config.
// Returns an `AuthStateResult` describing which auth path the app should take.
export { resolveAuthState } from '../auth/resolveAuthState';
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