/**
 * @fileoverview Email confirmation helpers for the `/confirm` route.
 *
 * Extracts the OTP verification + device trust + error translation logic
 * so the scaffolded confirm page can focus on UI.
 */

import { verifyOtp } from '../supabase/auth.js';
import { trustPendingDevice } from '../auth/deviceVerification.js';

// =============================================================================
//  TYPES
// =============================================================================

/** Result of an email confirmation attempt. */
export interface ConfirmResult {
  success: boolean;
  error?: string;
}

// =============================================================================
//  PUBLIC API
// =============================================================================

/**
 * Handles email confirmation: verifies the OTP token, trusts the pending
 * device for device-verification types, and translates Supabase error
 * messages to user-friendly strings.
 *
 * @param tokenHash - The `token_hash` from the confirmation URL query params.
 * @param type      - The verification type from Supabase (`signup`, `email`, `email_change`, `magiclink`).
 * @returns `{ success: true }` on success, or `{ success: false, error }` on failure.
 */
export async function handleEmailConfirmation(
  tokenHash: string,
  type: 'signup' | 'email' | 'email_change' | 'magiclink'
): Promise<ConfirmResult> {
  try {
    const otpType = type === 'magiclink' ? 'email' : type;
    const { error } = await verifyOtp(tokenHash, otpType as 'signup' | 'email' | 'email_change');

    // For device-verification OTPs, trust the originating device
    if (!error && (type === 'email' || type === 'magiclink')) {
      await trustPendingDevice();
    }

    if (error) {
      const errorLower = error.toLowerCase();
      if (
        errorLower.includes('already') ||
        errorLower.includes('confirmed') ||
        errorLower.includes('used')
      ) {
        return {
          success: false,
          error: 'This email has already been confirmed. You can sign in to your account.'
        };
      } else if (errorLower.includes('expired') || errorLower.includes('invalid')) {
        return {
          success: false,
          error: 'This confirmation link has expired. Please request a new one from the login page.'
        };
      }
      return { success: false, error };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'An unexpected error occurred. Please try again.' };
  }
}

/**
 * Broadcasts an auth confirmation event via `BroadcastChannel` so other
 * tabs (e.g. the login page) can pick up the auth state change.
 *
 * @param channelName - The BroadcastChannel name (must match the login page).
 * @param type        - The verification type to include in the message.
 */
export async function broadcastAuthConfirmed(
  channelName: string,
  type: string
): Promise<'closed' | 'can_close' | 'no_broadcast'> {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) {
    return 'no_broadcast';
  }

  const channel = new BroadcastChannel(channelName);

  channel.postMessage({
    type: 'AUTH_CONFIRMED',
    verificationType: type
  });

  // Give the original tab time to process the message
  await new Promise((resolve) => setTimeout(resolve, 500));
  channel.close();

  // Attempt to close this confirmation tab
  try {
    window.close();
  } catch {
    // Browser policy may block window.close()
  }

  // If still here → close failed
  return 'can_close';
}
