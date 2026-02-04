/**
 * SMTP Credential Validation
 *
 * Tests SMTP connectivity using nodemailer's verify() method.
 * Matches the { valid, error } pattern used by validateSupabaseCredentials.
 */
import nodemailer from 'nodemailer';
/**
 * Validate SMTP credentials by attempting to connect and authenticate.
 *
 * Returns `{ valid: true }` on success, or `{ valid: false, error }` on failure.
 * Never throws.
 */
export async function validateSmtpCredentials(config) {
    try {
        const transporter = nodemailer.createTransport({
            host: config.smtpHost,
            port: config.smtpPort,
            secure: config.smtpPort === 465,
            auth: {
                user: config.smtpUser,
                pass: config.smtpPass
            }
        });
        await transporter.verify();
        return { valid: true };
    }
    catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown SMTP error';
        return { valid: false, error: message };
    }
}
//# sourceMappingURL=validateSmtp.js.map