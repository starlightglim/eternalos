/**
 * Email utility for EternalOS.
 *
 * Prefers the **Cloudflare Email Service** binding (no API key, auto-configured
 * SPF/DKIM/DMARC on verified domains) and falls back to **Resend** when that
 * binding isn't available. If neither is configured, logs a warning and
 * returns false so callers degrade gracefully.
 *
 * Setup:
 *   Cloudflare Email (preferred):
 *     - Verify sending domain in Cloudflare dashboard (Email Routing → Outbound).
 *     - Add to wrangler.toml:
 *         send_email = [{ name = "SEND_EMAIL" }]
 *     - Set FROM_EMAIL to an address on the verified domain.
 *   Resend (fallback):
 *     - wrangler secret put RESEND_API_KEY
 *     - Set FROM_EMAIL to a Resend-verified sender.
 */

import { createMimeMessage } from 'mimetext';

// Cloudflare's runtime module. The TS types come from @cloudflare/workers-types
// when available; the runtime import is what matters at execution time.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — cloudflare:email is a Workers-runtime-only module
import { EmailMessage } from 'cloudflare:email';

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Env subset needed for email — typed loosely so this module doesn't need to
 * import the full Env and risk a circular dependency.
 */
export interface EmailCapableEnv {
  SEND_EMAIL?: { send(message: unknown): Promise<void> };
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
}

interface ResendErrorResponse {
  id?: string;
  message?: string;
}

/**
 * Parse a "Name <address@domain>" style FROM_EMAIL into its parts.
 * Returns address-only for the sender envelope (Cloudflare Email requires a
 * bare address there) plus the full display form for the MIME From: header.
 */
function parseFromEmail(fromEmail: string): { address: string; display: string } {
  const match = fromEmail.match(/^\s*(.*?)\s*<\s*([^>]+?)\s*>\s*$/);
  if (match) {
    const name = match[1].replace(/^"|"$/g, '').trim();
    const address = match[2].trim();
    return { address, display: name ? `${name} <${address}>` : address };
  }
  const address = fromEmail.trim();
  return { address, display: address };
}

/**
 * Send via the Cloudflare Email Service binding. Builds a proper MIME message
 * including both HTML and plain-text parts for multipart/alternative.
 */
async function sendViaCloudflareEmail(
  binding: NonNullable<EmailCapableEnv['SEND_EMAIL']>,
  fromEmail: string,
  params: SendEmailParams,
): Promise<boolean> {
  try {
    const { address: fromAddress, display: fromDisplay } = parseFromEmail(fromEmail);
    const msg = createMimeMessage();
    msg.setSender(fromDisplay);
    msg.setRecipient(params.to);
    msg.setSubject(params.subject);
    msg.addMessage({ contentType: 'text/html', data: params.html });
    if (params.text) {
      msg.addMessage({ contentType: 'text/plain', data: params.text });
    }

    const message = new EmailMessage(fromAddress, params.to, msg.asRaw());
    await binding.send(message);
    return true;
  } catch (error) {
    console.error('Cloudflare Email send error:', error);
    return false;
  }
}

/**
 * Send via the Resend HTTP API. Kept for fallback when the CF binding isn't
 * configured (local dev without sending-domain verification, or hosts that
 * prefer to retain Resend).
 */
async function sendViaResend(
  apiKey: string,
  fromEmail: string,
  params: SendEmailParams,
): Promise<boolean> {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: params.to,
        subject: params.subject,
        html: params.html,
        ...(params.text ? { text: params.text } : {}),
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as ResendErrorResponse;
      console.error('Resend API error:', response.status, error.message || 'Unknown error');
      return false;
    }
    return true;
  } catch (error) {
    console.error('Resend send error:', error);
    return false;
  }
}

/**
 * Send an email using whichever backend is configured. Prefers the
 * Cloudflare Email binding; falls back to Resend; returns false if neither is
 * available. Never throws.
 *
 * Callers typically pass the worker's `env` directly:
 *   await sendEmail(env, { to, subject, html, text });
 */
export async function sendEmail(
  env: EmailCapableEnv,
  params: SendEmailParams,
): Promise<boolean> {
  const fromEmail = env.FROM_EMAIL;
  if (!fromEmail) {
    console.warn('sendEmail: FROM_EMAIL is not configured — skipping send to', params.to);
    return false;
  }

  if (env.SEND_EMAIL) {
    const ok = await sendViaCloudflareEmail(env.SEND_EMAIL, fromEmail, params);
    if (ok) return true;
    // Fall through to Resend if the CF send fails and Resend is configured.
    if (env.RESEND_API_KEY) {
      console.warn('Cloudflare Email send failed; falling back to Resend');
      return sendViaResend(env.RESEND_API_KEY, fromEmail, params);
    }
    return false;
  }

  if (env.RESEND_API_KEY) {
    return sendViaResend(env.RESEND_API_KEY, fromEmail, params);
  }

  console.warn(
    'sendEmail: no email backend configured (SEND_EMAIL binding + RESEND_API_KEY both missing). Skipping send to',
    params.to,
  );
  return false;
}

/**
 * Generate password reset email HTML
 */
/**
 * HTML-escape a string for safe embedding in HTML templates
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Generate password reset email HTML
 */
export function getPasswordResetEmail(resetUrl: string, username: string): { html: string; text: string } {
  const safeUsername = escapeHtml(username);
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #C0C0C0; font-family: Geneva, Verdana, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="400" cellpadding="0" cellspacing="0" style="background: #FFFFFF; border: 2px solid #000000;">
          <!-- Title bar -->
          <tr>
            <td style="height: 22px; background: repeating-linear-gradient(0deg, #FFFFFF 0px, #FFFFFF 1px, #000000 1px, #000000 3px); border-bottom: 1px solid #000000; text-align: center;">
              <span style="background: #FFFFFF; padding: 0 12px; font-family: Chicago, Geneva, sans-serif; font-size: 12px;">EternalOS</span>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 28px 24px;">
              <p style="font-size: 14px; color: #000000; margin: 0 0 16px 0;">
                Hi @${safeUsername},
              </p>
              <p style="font-size: 13px; color: #333333; margin: 0 0 20px 0; line-height: 1.5;">
                We received a request to reset your password. Click the button below to choose a new one.
              </p>
              <!-- Button -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 20px 0;">
                <tr>
                  <td align="center">
                    <a href="${resetUrl}" style="display: inline-block; padding: 10px 28px; background: #FFFFFF; border: 2px solid #000000; border-radius: 6px; font-family: Chicago, Geneva, sans-serif; font-size: 13px; color: #000000; text-decoration: none;">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>
              <p style="font-size: 11px; color: #888888; margin: 0 0 12px 0; line-height: 1.4;">
                This link expires in 1 hour. If you didn't request this, you can safely ignore this email.
              </p>
              <hr style="border: none; border-top: 1px solid #C0C0C0; margin: 16px 0;" />
              <p style="font-size: 10px; color: #AAAAAA; margin: 0; text-align: center;">
                EternalOS &mdash; Your corner of the internet
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  const text = `Hi @${username},

We received a request to reset your EternalOS password.

Reset your password here: ${resetUrl}

This link expires in 1 hour. If you didn't request this, you can safely ignore this email.

— EternalOS`;

  return { html, text };
}

/**
 * Generate email verification email HTML
 */
export function getEmailVerificationEmail(verifyUrl: string, username: string): { html: string; text: string } {
  const safeUsername = escapeHtml(username);
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #C0C0C0; font-family: Geneva, Verdana, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="400" cellpadding="0" cellspacing="0" style="background: #FFFFFF; border: 2px solid #000000;">
          <tr>
            <td style="height: 22px; background: repeating-linear-gradient(0deg, #FFFFFF 0px, #FFFFFF 1px, #000000 1px, #000000 3px); border-bottom: 1px solid #000000; text-align: center;">
              <span style="background: #FFFFFF; padding: 0 12px; font-family: Chicago, Geneva, sans-serif; font-size: 12px;">EternalOS</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 28px 24px;">
              <p style="font-size: 14px; color: #000000; margin: 0 0 16px 0;">
                Hi @${safeUsername},
              </p>
              <p style="font-size: 13px; color: #333333; margin: 0 0 20px 0; line-height: 1.5;">
                Please verify your email address to complete your EternalOS account setup.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 20px 0;">
                <tr>
                  <td align="center">
                    <a href="${verifyUrl}" style="display: inline-block; padding: 10px 28px; background: #FFFFFF; border: 2px solid #000000; border-radius: 6px; font-family: Chicago, Geneva, sans-serif; font-size: 13px; color: #000000; text-decoration: none;">
                      Verify Email
                    </a>
                  </td>
                </tr>
              </table>
              <p style="font-size: 11px; color: #888888; margin: 0 0 12px 0; line-height: 1.4;">
                This link expires in 24 hours. If you didn't create an EternalOS account, you can safely ignore this email.
              </p>
              <hr style="border: none; border-top: 1px solid #C0C0C0; margin: 16px 0;" />
              <p style="font-size: 10px; color: #AAAAAA; margin: 0; text-align: center;">
                EternalOS &mdash; Your corner of the internet
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  const text = `Hi @${username},

Please verify your email address for your EternalOS account.

Verify here: ${verifyUrl}

This link expires in 24 hours. If you didn't create an EternalOS account, you can safely ignore this email.

— EternalOS`;

  return { html, text };
}

/**
 * Generate username change notification email HTML
 */
export function getUsernameChangeEmail(oldUsername: string, newUsername: string): { html: string; text: string } {
  const safeOld = escapeHtml(oldUsername);
  const safeNew = escapeHtml(newUsername);
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #C0C0C0; font-family: Geneva, Verdana, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="400" cellpadding="0" cellspacing="0" style="background: #FFFFFF; border: 2px solid #000000;">
          <tr>
            <td style="height: 22px; background: repeating-linear-gradient(0deg, #FFFFFF 0px, #FFFFFF 1px, #000000 1px, #000000 3px); border-bottom: 1px solid #000000; text-align: center;">
              <span style="background: #FFFFFF; padding: 0 12px; font-family: Chicago, Geneva, sans-serif; font-size: 12px;">EternalOS</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 28px 24px;">
              <p style="font-size: 14px; color: #000000; margin: 0 0 16px 0;">
                Hi @${safeNew},
              </p>
              <p style="font-size: 13px; color: #333333; margin: 0 0 20px 0; line-height: 1.5;">
                Your EternalOS username has been changed from <strong>@${safeOld}</strong> to <strong>@${safeNew}</strong>.
              </p>
              <p style="font-size: 13px; color: #333333; margin: 0 0 20px 0; line-height: 1.5;">
                Your new public desktop URL is: <strong>eternalos.app/@${safeNew}</strong>
              </p>
              <p style="font-size: 11px; color: #888888; margin: 0 0 12px 0; line-height: 1.4;">
                If you didn't make this change, please reset your password immediately.
              </p>
              <hr style="border: none; border-top: 1px solid #C0C0C0; margin: 16px 0;" />
              <p style="font-size: 10px; color: #AAAAAA; margin: 0; text-align: center;">
                EternalOS &mdash; Your corner of the internet
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  const text = `Hi @${newUsername},

Your EternalOS username has been changed from @${oldUsername} to @${newUsername}.

Your new public desktop URL is: eternalos.app/@${newUsername}

If you didn't make this change, please reset your password immediately.

— EternalOS`;

  return { html, text };
}
