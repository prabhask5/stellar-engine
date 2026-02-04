/**
 * SMTP Credential Validation
 *
 * Tests SMTP connectivity using nodemailer's verify() method.
 * Matches the { valid, error } pattern used by validateSupabaseCredentials.
 */
import type { EmailConfig } from './sendEmail';
/**
 * Validate SMTP credentials by attempting to connect and authenticate.
 *
 * Returns `{ valid: true }` on success, or `{ valid: false, error }` on failure.
 * Never throws.
 */
export declare function validateSmtpCredentials(config: EmailConfig): Promise<{
    valid: boolean;
    error?: string;
}>;
//# sourceMappingURL=validateSmtp.d.ts.map