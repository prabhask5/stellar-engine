/**
 * Admin Check
 *
 * Delegates to config.auth.adminCheck or returns false.
 */
import { getEngineConfig } from '../config';
/**
 * Check if a user has admin privileges.
 * Uses the adminCheck function from engine config if provided.
 */
export function isAdmin(user) {
    try {
        const config = getEngineConfig();
        // Single-user mode: always admin
        if (config.auth?.mode === 'single-user')
            return true;
        if (config.auth?.adminCheck) {
            return config.auth.adminCheck(user);
        }
    }
    catch {
        // Engine not initialized yet
    }
    return false;
}
//# sourceMappingURL=admin.js.map