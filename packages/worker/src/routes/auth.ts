/**
 * Auth Routes
 *
 * POST /api/auth/signup           - Create account
 * POST /api/auth/login            - Authenticate
 * POST /api/auth/logout           - Invalidate session
 * POST /api/auth/forgot-password  - Request password reset
 * POST /api/auth/reset-password   - Reset password with token
 */

import type { Env } from '../index';
import type { UserRecord, SessionRecord, PasswordResetRecord } from '../types';
import { signJWT } from '../utils/jwt';
import { hashPassword, verifyPassword } from '../utils/password';
import { sanitizeEmail, sanitizeUsername } from '../utils/sanitize';
import { sendEmail, getPasswordResetEmail } from '../utils/email';

interface SignupBody {
  email: string;
  password: string;
  username: string;
}

interface LoginBody {
  email: string;
  password: string;
}

/**
 * Generate a secure refresh token
 */
function generateRefreshToken(): string {
  return crypto.randomUUID() + '-' + crypto.randomUUID();
}

// Validation helpers
function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password: string): string | null {
  if (password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (password.length > 128) {
    return 'Password must be 128 characters or less';
  }
  if (!/[a-z]/.test(password)) {
    return 'Password must contain at least one lowercase letter';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number';
  }
  return null;
}

function validateUsername(username: string): string | null {
  if (username.length < 3) {
    return 'Username must be at least 3 characters';
  }
  if (username.length > 20) {
    return 'Username must be 20 characters or less';
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return 'Username can only contain letters, numbers, and underscores';
  }
  // Reserved usernames
  const reserved = ['admin', 'api', 'www', 'mail', 'root', 'help', 'support'];
  if (reserved.includes(username.toLowerCase())) {
    return 'This username is reserved';
  }
  return null;
}

/**
 * POST /api/auth/signup
 * Create a new user account
 */
export async function handleSignup(request: Request, env: Env): Promise<Response> {
  let body: SignupBody;
  try {
    body = await request.json() as SignupBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { email, password, username } = body;

  // Validate inputs
  if (!email || !password || !username) {
    return Response.json({ error: 'Email, password, and username are required' }, { status: 400 });
  }

  if (!validateEmail(email)) {
    return Response.json({ error: 'Invalid email format' }, { status: 400 });
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    return Response.json({ error: passwordError }, { status: 400 });
  }

  const usernameError = validateUsername(username);
  if (usernameError) {
    return Response.json({ error: usernameError }, { status: 400 });
  }

  const normalizedEmail = sanitizeEmail(email);
  const normalizedUsername = sanitizeUsername(username);

  // Check if email already exists
  let existingUser: string | null;
  try {
    existingUser = await env.AUTH_KV.get(`user:${normalizedEmail}`);
  } catch (e) {
    console.error('Signup: check email failed:', e);
    return Response.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }
  if (existingUser) {
    return Response.json({ error: 'Email already registered' }, { status: 409 });
  }

  // Check if username is taken
  let existingUsername: string | null;
  try {
    existingUsername = await env.AUTH_KV.get(`username:${normalizedUsername}`);
  } catch (e) {
    console.error('Signup: check username failed:', e);
    return Response.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }
  if (existingUsername) {
    return Response.json({ error: 'Username already taken' }, { status: 409 });
  }

  // Generate user ID and hash password
  const uid = crypto.randomUUID();
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch (e) {
    console.error('Signup: hash password failed:', e);
    return Response.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }
  const now = Date.now();

  // Create user record
  const userRecord: UserRecord = {
    uid,
    email: normalizedEmail,
    passwordHash,
    username: normalizedUsername,
    createdAt: now,
  };

  // Store user data in KV
  try {
    await env.AUTH_KV.put(`user:${normalizedEmail}`, JSON.stringify(userRecord));
  } catch (e) {
    console.error('Signup: store user failed:', e);
    return Response.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }

  try {
    await env.AUTH_KV.put(`username:${normalizedUsername}`, JSON.stringify({ uid }));
  } catch (e) {
    console.error('Signup: store username failed:', e);
    return Response.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }

  try {
    await env.AUTH_KV.put(`uid:${uid}`, JSON.stringify({ email: normalizedEmail }));
  } catch (e) {
    console.error('Signup: store uid index failed:', e);
    return Response.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }

  // Track this user for scheduled jobs (per-user key avoids read-modify-write race)
  try {
    await env.AUTH_KV.put(`user_index:${uid}`, normalizedEmail);
  } catch (e) {
    console.error('Signup: update user list failed:', e);
    return Response.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }

  // Initialize user's Durable Object with profile and default items
  try {
    const doId = env.USER_DESKTOP.idFromName(uid);
    const stub = env.USER_DESKTOP.get(doId);

    // Initialize profile with isNewUser flag
    await stub.fetch(new Request('http://internal/profile', {
      method: 'POST',
      body: JSON.stringify({
        uid,
        username: normalizedUsername,
        displayName: username,
        wallpaper: 'default',
        createdAt: now,
        isNewUser: true,
      }),
    }));

    // Create default desktop items for new users
    const gettingStartedId = crypto.randomUUID();
    const readMeId = crypto.randomUUID();

    const defaultItems = [
      // Read Me file (auto-opened on first visit)
      {
        id: readMeId,
        type: 'text',
        name: 'Read Me.txt',
        parentId: null,
        position: { x: 0, y: 0 },
        isPublic: true,
        textContent: `Welcome to EternalOS!

Your personal corner of the internet, styled like a classic Mac.

=== Getting Started ===

• Double-click any item to open it
• Right-click for context menus
• Drag items to move them around
• Drop files from your computer to upload

=== Make It Yours ===

• Right-click the desktop → "Change Wallpaper..."
• Special menu → "Appearance..." for colors
• Right-click items → "Change Icon..." for custom icons
• Special menu → "Custom CSS..." for power users

=== Share Your Desktop ===

Your public items are visible at:
  eternalos.app/@${normalizedUsername}

Toggle "Public" in Get Info (⌘I) to share items.

=== Need Help? ===

Double-click the Desk Assistant for AI-powered help
with customizing your desktop.

Happy computing!
— EternalOS`,
      },
      // Getting Started folder
      {
        id: gettingStartedId,
        type: 'folder',
        name: 'Getting Started',
        parentId: null,
        position: { x: 0, y: 1 },
        isPublic: true,
      },
      // Items inside Getting Started folder
      {
        id: crypto.randomUUID(),
        type: 'text',
        name: 'Keyboard Shortcuts.txt',
        parentId: gettingStartedId,
        position: { x: 0, y: 0 },
        isPublic: true,
        textContent: `EternalOS Keyboard Shortcuts

=== Window Management ===
⌘W  Close window
⌘\`  Cycle through windows

=== Selection & Editing ===
⌘A  Select all items
⌘I  Get Info
⌘D  Duplicate
⌘F  Find/Search

=== File Operations ===
⌘N  New folder
Delete  Move to Trash
Enter  Rename selected item
Arrows  Navigate items

=== View ===
Escape  Deselect all / Close dialogs`,
      },
      {
        id: crypto.randomUUID(),
        type: 'text',
        name: 'Tips & Tricks.txt',
        parentId: gettingStartedId,
        position: { x: 0, y: 1 },
        isPublic: true,
        textContent: `Tips & Tricks

=== Customization ===

1. ACCENT COLORS
   Special → Appearance → Colors tab
   Pick a color to theme your desktop

2. CUSTOM ICONS
   Right-click any item → "Change Icon..."
   Choose from 30+ pixel-art icons

3. WIDGETS
   Right-click desktop → "New Widget..."
   Add sticky notes, guestbooks, and more

4. CUSTOM CSS (Power Users)
   Special → Custom CSS...
   Write CSS to transform your desktop

=== Pro Tips ===

• Window shade: Double-click title bar
• Multi-select: Shift+click or drag to select
• Quick rename: Click item, press Enter
• View as icons/list: View menu

=== Ask the Assistant ===

Try saying:
• "Make my desktop feel like a rainy day"
• "Add a guestbook widget"
• "Change all folder icons to blue"`,
      },
      // Desk Assistant widget is already handled separately
    ];

    // Create each default item
    for (const item of defaultItems) {
      await stub.fetch(new Request('http://internal/items', {
        method: 'POST',
        body: JSON.stringify(item),
      }));
    }
  } catch (e) {
    console.error('Signup: init durable object failed:', e);
    return Response.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }

  // Generate JWT
  let token: string;
  try {
    token = await signJWT({ uid, username: normalizedUsername }, env.JWT_SECRET);
  } catch (e) {
    console.error('Signup: sign JWT failed:', e);
    return Response.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }

  const refreshToken = generateRefreshToken();
  const accessExpiry = 15 * 60;
  const refreshExpiry = 7 * 24 * 60 * 60;

  // Store session in KV
  const sessionRecord: SessionRecord = {
    uid,
    expiresAt: now + (accessExpiry * 1000),
    issuedAt: now,
    refreshToken,
    refreshExpiresAt: now + (refreshExpiry * 1000),
  };

  try {
    await env.AUTH_KV.put(`session:${token}`, JSON.stringify(sessionRecord), {
      expirationTtl: accessExpiry,
    });
  } catch (e) {
    console.error('Signup: store session failed:', e);
    return Response.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }

  // Store refresh token (includes issuedAt for password-change invalidation)
  const refreshData = {
    uid,
    username: normalizedUsername,
    accessToken: token,
    expiresAt: now + (refreshExpiry * 1000),
    issuedAt: now,
  };

  try {
    await env.AUTH_KV.put(`refresh:${refreshToken}`, JSON.stringify(refreshData), {
      expirationTtl: refreshExpiry,
    });
  } catch (e) {
    console.error('Signup: store refresh token failed:', e);
    return Response.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }

  return Response.json({
    token,
    refreshToken,
    expiresIn: accessExpiry,
    user: {
      uid,
      username: normalizedUsername,
      email: normalizedEmail,
    },
  });
}

/**
 * POST /api/auth/login
 * Authenticate existing user
 */
export async function handleLogin(request: Request, env: Env): Promise<Response> {
  let body: LoginBody;
  try {
    body = await request.json() as LoginBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { email, password } = body;

  // Validate inputs
  if (!email || !password) {
    return Response.json({ error: 'Email and password are required' }, { status: 400 });
  }

  const normalizedEmail = sanitizeEmail(email);

  // Look up user
  let userJson: string | null;
  try {
    userJson = await env.AUTH_KV.get(`user:${normalizedEmail}`);
  } catch (kvError) {
    console.error('KV error during login:', kvError);
    return Response.json({ error: 'Database error' }, { status: 500 });
  }

  if (!userJson) {
    // Use generic message to prevent user enumeration
    return Response.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  let userRecord: UserRecord;
  try {
    userRecord = JSON.parse(userJson) as UserRecord;
  } catch (parseError) {
    console.error('Failed to parse user record:', parseError);
    return Response.json({ error: 'Data corruption error' }, { status: 500 });
  }

  // Verify password
  let valid: boolean;
  try {
    valid = await verifyPassword(password, userRecord.passwordHash);
  } catch (pwError) {
    console.error('Password verification error:', pwError);
    return Response.json({ error: 'Authentication error' }, { status: 500 });
  }

  if (!valid) {
    return Response.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  // Check if JWT_SECRET is available
  if (!env.JWT_SECRET) {
    console.error('JWT_SECRET is not configured');
    return Response.json({ error: 'Server configuration error' }, { status: 500 });
  }

  // Generate new JWT
  let token: string;
  try {
    token = await signJWT(
      { uid: userRecord.uid, username: userRecord.username },
      env.JWT_SECRET
    );
  } catch (jwtError) {
    console.error('JWT signing error:', jwtError);
    return Response.json({ error: 'Token generation error' }, { status: 500 });
  }

  // Generate refresh token
  const now = Date.now();
  const refreshToken = generateRefreshToken();

  // Access token: 15 minutes, Refresh token: 7 days
  const accessExpiry = 15 * 60; // 15 minutes in seconds
  const refreshExpiry = 7 * 24 * 60 * 60; // 7 days in seconds

  // Store session in KV
  const sessionRecord: SessionRecord = {
    uid: userRecord.uid,
    expiresAt: now + (accessExpiry * 1000),
    issuedAt: now,
    refreshToken,
    refreshExpiresAt: now + (refreshExpiry * 1000),
  };

  try {
    await env.AUTH_KV.put(`session:${token}`, JSON.stringify(sessionRecord), {
      expirationTtl: accessExpiry,
    });
  } catch (sessionError) {
    console.error('Session storage error:', sessionError);
    return Response.json({ error: 'Session creation error' }, { status: 500 });
  }

  // Store refresh token (includes issuedAt for password-change invalidation)
  const refreshData = {
    uid: userRecord.uid,
    username: userRecord.username,
    accessToken: token,
    expiresAt: now + (refreshExpiry * 1000),
    issuedAt: now,
  };

  try {
    await env.AUTH_KV.put(`refresh:${refreshToken}`, JSON.stringify(refreshData), {
      expirationTtl: refreshExpiry,
    });
  } catch (refreshError) {
    console.error('Refresh token storage error:', refreshError);
    return Response.json({ error: 'Session creation error' }, { status: 500 });
  }

  return Response.json({
    token,
    refreshToken,
    expiresIn: accessExpiry,
    user: {
      uid: userRecord.uid,
      username: userRecord.username,
      email: normalizedEmail,
    },
  });
}

/**
 * POST /api/auth/logout
 * Invalidate session
 */
export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return Response.json({ error: 'No token provided' }, { status: 400 });
  }

  const token = authHeader.slice('Bearer '.length);

  // Get session to also delete refresh token
  const sessionJson = await env.AUTH_KV.get(`session:${token}`);
  if (sessionJson) {
    const session = JSON.parse(sessionJson) as SessionRecord;
    if (session.refreshToken) {
      await env.AUTH_KV.delete(`refresh:${session.refreshToken}`);
    }
  }

  // Delete session from KV
  await env.AUTH_KV.delete(`session:${token}`);

  return Response.json({ success: true });
}

interface RefreshTokenBody {
  refreshToken: string;
}

/**
 * POST /api/auth/refresh
 * Exchange a refresh token for a new access token (token rotation)
 */
export async function handleRefreshToken(request: Request, env: Env): Promise<Response> {
  let body: RefreshTokenBody;
  try {
    body = await request.json() as RefreshTokenBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { refreshToken } = body;

  if (!refreshToken) {
    return Response.json({ error: 'Refresh token is required' }, { status: 400 });
  }

  // Look up refresh token
  const refreshJson = await env.AUTH_KV.get(`refresh:${refreshToken}`);
  if (!refreshJson) {
    return Response.json({ error: 'Invalid or expired refresh token' }, { status: 401 });
  }

  const refreshData = JSON.parse(refreshJson) as {
    uid: string;
    username: string;
    accessToken: string;
    expiresAt: number;
    issuedAt?: number; // Added for password-change invalidation
  };

  // Check if refresh token has expired
  if (Date.now() > refreshData.expiresAt) {
    await env.AUTH_KV.delete(`refresh:${refreshToken}`);
    return Response.json({ error: 'Refresh token has expired' }, { status: 401 });
  }

  // Check if password was changed after refresh token was issued.
  // Uses issuedAt from the refresh token record directly — does NOT depend
  // on the access token session existing (which expires after 15 min).
  const uidIndexJson = await env.AUTH_KV.get(`uid:${refreshData.uid}`);
  if (uidIndexJson) {
    const { email } = JSON.parse(uidIndexJson) as { email: string };
    const userJson = await env.AUTH_KV.get(`user:${email}`);
    if (userJson) {
      const user = JSON.parse(userJson) as UserRecord;
      // Use refresh token's own issuedAt (reliable), fall back to old session check
      const tokenIssuedAt = refreshData.issuedAt;
      if (tokenIssuedAt && user.passwordChangedAt && tokenIssuedAt < user.passwordChangedAt) {
        // Password was changed after this refresh token was issued — invalidate
        await env.AUTH_KV.delete(`refresh:${refreshToken}`);
        await env.AUTH_KV.delete(`session:${refreshData.accessToken}`);
        return Response.json({ error: 'Session invalidated due to password change' }, { status: 401 });
      }

      // Fallback for old refresh tokens that don't have issuedAt yet
      if (!tokenIssuedAt && user.passwordChangedAt) {
        const oldSessionJson = await env.AUTH_KV.get(`session:${refreshData.accessToken}`);
        if (oldSessionJson) {
          const oldSession = JSON.parse(oldSessionJson) as SessionRecord;
          if (oldSession.issuedAt < user.passwordChangedAt) {
            await env.AUTH_KV.delete(`refresh:${refreshToken}`);
            await env.AUTH_KV.delete(`session:${refreshData.accessToken}`);
            return Response.json({ error: 'Session invalidated due to password change' }, { status: 401 });
          }
        }
      }
    }
  }

  // Delete old refresh token (one-time use for rotation)
  await env.AUTH_KV.delete(`refresh:${refreshToken}`);
  // Delete old access token session
  await env.AUTH_KV.delete(`session:${refreshData.accessToken}`);

  // Generate new tokens
  const now = Date.now();
  const newAccessToken = await signJWT({ uid: refreshData.uid, username: refreshData.username }, env.JWT_SECRET);
  const newRefreshToken = generateRefreshToken();

  // Access token: 15 minutes, Refresh token: 7 days
  const accessExpiry = 15 * 60; // 15 minutes in seconds
  const refreshExpiry = 7 * 24 * 60 * 60; // 7 days in seconds

  // Store new session
  const sessionRecord: SessionRecord = {
    uid: refreshData.uid,
    expiresAt: now + (accessExpiry * 1000),
    issuedAt: now,
    refreshToken: newRefreshToken,
    refreshExpiresAt: now + (refreshExpiry * 1000),
  };
  await env.AUTH_KV.put(`session:${newAccessToken}`, JSON.stringify(sessionRecord), {
    expirationTtl: accessExpiry,
  });

  // Store new refresh token (includes issuedAt for password-change invalidation)
  const newRefreshData = {
    uid: refreshData.uid,
    username: refreshData.username,
    accessToken: newAccessToken,
    expiresAt: now + (refreshExpiry * 1000),
    issuedAt: now,
  };
  await env.AUTH_KV.put(`refresh:${newRefreshToken}`, JSON.stringify(newRefreshData), {
    expirationTtl: refreshExpiry,
  });

  return Response.json({
    token: newAccessToken,
    refreshToken: newRefreshToken,
    expiresIn: accessExpiry,
  });
}

interface ForgotPasswordBody {
  email: string;
}

/**
 * POST /api/auth/forgot-password
 * Request a password reset token
 */
export async function handleForgotPassword(request: Request, env: Env): Promise<Response> {
  let body: ForgotPasswordBody;
  try {
    body = await request.json() as ForgotPasswordBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { email } = body;

  if (!email) {
    return Response.json({ error: 'Email is required' }, { status: 400 });
  }

  if (!validateEmail(email)) {
    return Response.json({ error: 'Invalid email format' }, { status: 400 });
  }

  const normalizedEmail = sanitizeEmail(email);

  // Look up user by email
  const userJson = await env.AUTH_KV.get(`user:${normalizedEmail}`);

  // Always return success to prevent email enumeration attacks
  // Even if user doesn't exist, we return the same response
  if (!userJson) {
    return Response.json({
      success: true,
      message: 'If an account with that email exists, a reset link has been generated.',
    });
  }

  const userRecord = JSON.parse(userJson) as UserRecord;

  // Generate a secure reset token
  const resetToken = crypto.randomUUID() + '-' + crypto.randomUUID();
  const now = Date.now();
  const ttlSeconds = 60 * 60; // 1 hour TTL

  const resetRecord: PasswordResetRecord = {
    uid: userRecord.uid,
    email: normalizedEmail,
    createdAt: now,
    expiresAt: now + (ttlSeconds * 1000),
  };

  // Store reset token in KV with TTL
  await env.AUTH_KV.put(`reset:${resetToken}`, JSON.stringify(resetRecord), {
    expirationTtl: ttlSeconds,
  });

  // Build the reset URL
  const appUrl = env.APP_URL || 'https://eternalos.app';
  const resetUrl = `${appUrl}/reset-password?token=${resetToken}`;

  const isDev = env.ENVIRONMENT !== 'production';

  // Send password reset email (if Resend is configured)
  if (env.RESEND_API_KEY && env.FROM_EMAIL) {
    const { html, text } = getPasswordResetEmail(resetUrl, userRecord.username);
    const sent = await sendEmail(env.RESEND_API_KEY, env.FROM_EMAIL, {
      to: normalizedEmail,
      subject: 'Reset your EternalOS password',
      html,
      text,
    });

    if (!sent) {
      console.error(`Failed to send password reset email to ${normalizedEmail}`);
    }
  } else if (isDev) {
    // In development without email configured, log the reset URL
    console.log(`[DEV] Password reset URL: ${resetUrl}`);
  }

  return Response.json({
    success: true,
    message: 'If an account with that email exists, a reset link has been generated.',
    // Only include token in development mode — NEVER in production
    ...(isDev ? { resetToken, resetUrl } : {}),
  });
}

interface ResetPasswordBody {
  token: string;
  newPassword: string;
}

/**
 * POST /api/auth/reset-password
 * Reset password using a valid reset token
 */
export async function handleResetPassword(request: Request, env: Env): Promise<Response> {
  let body: ResetPasswordBody;
  try {
    body = await request.json() as ResetPasswordBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { token, newPassword } = body;

  if (!token) {
    return Response.json({ error: 'Reset token is required' }, { status: 400 });
  }

  if (!newPassword) {
    return Response.json({ error: 'New password is required' }, { status: 400 });
  }

  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    return Response.json({ error: passwordError }, { status: 400 });
  }

  // Look up the reset token
  const resetJson = await env.AUTH_KV.get(`reset:${token}`);
  if (!resetJson) {
    return Response.json({ error: 'Invalid or expired reset token' }, { status: 400 });
  }

  const resetRecord = JSON.parse(resetJson) as PasswordResetRecord;

  // Check if token has expired (double-check since KV TTL handles this too)
  if (Date.now() > resetRecord.expiresAt) {
    await env.AUTH_KV.delete(`reset:${token}`);
    return Response.json({ error: 'Reset token has expired' }, { status: 400 });
  }

  // Get the user record
  const userJson = await env.AUTH_KV.get(`user:${resetRecord.email}`);
  if (!userJson) {
    // User was deleted after reset was requested
    await env.AUTH_KV.delete(`reset:${token}`);
    return Response.json({ error: 'Account no longer exists' }, { status: 400 });
  }

  const userRecord = JSON.parse(userJson) as UserRecord;

  // Hash the new password
  const newPasswordHash = await hashPassword(newPassword);
  const now = Date.now();

  // Update the user record with new password and passwordChangedAt timestamp
  // This invalidates all existing sessions since they were issued before this timestamp
  const updatedUserRecord: UserRecord = {
    ...userRecord,
    passwordHash: newPasswordHash,
    passwordChangedAt: now,
  };

  await env.AUTH_KV.put(`user:${resetRecord.email}`, JSON.stringify(updatedUserRecord));

  // Delete the reset token (one-time use)
  await env.AUTH_KV.delete(`reset:${token}`);

  // All existing sessions are now invalid because their issuedAt < passwordChangedAt
  // The auth middleware will check this condition and reject old sessions

  return Response.json({
    success: true,
    message: 'Password has been reset successfully. You can now log in with your new password.',
  });
}
