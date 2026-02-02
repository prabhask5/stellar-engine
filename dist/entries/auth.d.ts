export { signIn, signUp, signOut, changePassword, resendConfirmationEmail, getUserProfile, updateProfile, verifyOtp, getValidSession } from '../supabase/auth';
export type { AuthResponse } from '../supabase/auth';
export { resolveAuthState } from '../auth/resolveAuthState';
export type { AuthStateResult } from '../auth/resolveAuthState';
export { isAdmin } from '../auth/admin';
export { signInOffline, getOfflineLoginInfo } from '../auth/offlineLogin';
export { isSingleUserSetUp, getSingleUserInfo, setupSingleUser, unlockSingleUser, lockSingleUser, changeSingleUserGate, updateSingleUserProfile, resetSingleUser } from '../auth/singleUser';
//# sourceMappingURL=auth.d.ts.map