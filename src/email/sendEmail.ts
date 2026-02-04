/**
 * Email Sending Module
 *
 * Server-side email sending via SMTP using nodemailer.
 * Designed for use in API routes — never runs in the browser.
 */

import nodemailer from 'nodemailer';

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
export async function sendEmail(
  config: EmailConfig,
  params: SendEmailParams
): Promise<{ success: boolean; error?: string }> {
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

    await transporter.sendMail({
      from: `"${config.fromName}" <${config.fromEmail}>`,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text
    });

    return { success: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown email error';
    return { success: false, error: message };
  }
}
