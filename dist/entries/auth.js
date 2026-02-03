// Auth subpath barrel – @prabhask5/stellar-engine/auth
export { signIn, signUp, signOut, changePassword, changeEmail, completeEmailChange, resendConfirmationEmail, getUserProfile, updateProfile, verifyOtp, getValidSession } from '../supabase/auth';
export { resolveAuthState } from '../auth/resolveAuthState';
export { isAdmin } from '../auth/admin';
export { signInOffline, getOfflineLoginInfo } from '../auth/offlineLogin';
export { isSingleUserSetUp, getSingleUserInfo, setupSingleUser, unlockSingleUser, lockSingleUser, changeSingleUserGate, updateSingleUserProfile, resetSingleUser, completeSingleUserSetup, completeDeviceVerification, pollDeviceVerification, padPin, changeSingleUserEmail, completeSingleUserEmailChange, fetchRemoteGateConfig, linkSingleUserDevice, resetSingleUserRemote } from '../auth/singleUser';
//# sourceMappingURL=auth.js.map