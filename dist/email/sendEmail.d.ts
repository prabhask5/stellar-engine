/**
 * Email Sending Module
 *
 * Server-side email sending via SMTP using nodemailer.
 * Designed for use in API routes — never runs in the browser.
 */
export interface EmailConfig {
    smtpHost: string;
    smtpPort: number;
    smtpUser: string;
    smtpPass: string;
    fromEmail: string;
    fromName: string;
}
export interface SendEmailParams {
    to: string;
    subject: string;
    html: string;
    text?: string;
}
/**
 * Send an email via SMTP.
 *
 * Creates a nodemailer transporter from the provided config, sends the email,
 * and returns a result object. Never throws — errors are returned in the result.
 */
export declare function sendEmail(config: EmailConfig, params: SendEmailParams): Promise<{
    success: boolean;
    error?: string;
}>;
//# sourceMappingURL=sendEmail.d.ts.map