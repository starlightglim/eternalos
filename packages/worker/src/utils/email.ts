/**
 * Email utility for EternalOS
 *
 * Sends transactional emails via Resend API.
 * Requires RESEND_API_KEY secret and FROM_EMAIL env var.
 *
 * Setup:
 *   wrangler secret put RESEND_API_KEY
 *   Add FROM_EMAIL to wrangler.toml [vars] or .dev.vars
 */

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

interface ResendResponse {
  id?: string;
  message?: string;
}

/**
 * Send an email via Resend API
 * Returns true on success, false on failure (never throws)
 */
export async function sendEmail(
  apiKey: string,
  fromEmail: string,
  params: SendEmailParams
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
      const error = await response.json().catch(() => ({})) as ResendResponse;
      console.error('Resend API error:', response.status, error.message || 'Unknown error');
      return false;
    }

    return true;
  } catch (error) {
    console.error('Email send error:', error);
    return false;
  }
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
