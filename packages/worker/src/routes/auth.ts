/**
 * Auth Routes
 *
 * POST /api/auth/signup              - Create account
 * POST /api/auth/login               - Authenticate
 * POST /api/auth/logout              - Invalidate session
 * POST /api/auth/google              - Google OAuth code exchange
 * POST /api/auth/forgot-password     - Request password reset
 * POST /api/auth/reset-password      - Reset password with token
 * POST /api/auth/change-password     - Change password (authenticated)
 * POST /api/auth/change-username     - Change username (authenticated)
 * POST /api/auth/send-verification   - Send verification email (authenticated)
 * POST /api/auth/verify-email        - Verify email with token
 */

import type { Env } from '../index';
import type { UserRecord, SessionRecord, PasswordResetRecord, EmailVerificationRecord, OAuthProvider } from '../types';
import type { AuthContext } from '../middleware/auth';
import { signJWT } from '../utils/jwt';
import { hashPassword, verifyPassword } from '../utils/password';
import { sanitizeEmail, sanitizeUsername } from '../utils/sanitize';
import { sendEmail, getPasswordResetEmail, getEmailVerificationEmail, getUsernameChangeEmail } from '../utils/email';

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
  const reserved = ['admin', 'api', 'www', 'mail', 'root', 'help', 'support', 'system', 'test', 'app', 'docs', 'download', 'downloads', 'static', 'assets', 'public', 'private', 'settings', 'login', 'signup', 'register', 'auth', 'oauth', 'callback', 'webhook', 'webhooks', 'status', 'blog', 'about', 'contact', 'terms', 'privacy', 'security', 'abuse', 'postmaster', 'webmaster', 'hostmaster', 'info', 'billing', 'sales', 'legal', 'noreply', 'no_reply', 'null', 'undefined', 'desktop', 'verify', 'reset', 'forgot', 'password', 'account', 'profile', 'user', 'users', 'moderator', 'mod', 'staff', 'team', 'official', 'eternalos', 'eternal'];
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

  // SECURITY: Acquire short-lived locks on email + username before the
  // check-then-write sequence. This prevents concurrent signups from both
  // passing the existence check and overwriting each other's records.
  // The lock TTL (30s) is long enough to cover the signup flow and short
  // enough to auto-expire if a request crashes mid-flow.
  const emailLockKey = `signup-lock:email:${normalizedEmail}`;
  const usernameLockKey = `signup-lock:username:${normalizedUsername}`;
  const lockValue = crypto.randomUUID();
  const LOCK_TTL_SECONDS = 30;

  // Try to acquire email lock (put-if-absent pattern using a short TTL)
  const existingEmailLock = await env.AUTH_KV.get(emailLockKey);
  if (existingEmailLock) {
    return Response.json({ error: 'Signup in progress for this email. Please try again.' }, { status: 409 });
  }
  await env.AUTH_KV.put(emailLockKey, lockValue, { expirationTtl: LOCK_TTL_SECONDS });

  // Try to acquire username lock
  const existingUsernameLock = await env.AUTH_KV.get(usernameLockKey);
  if (existingUsernameLock) {
    await env.AUTH_KV.delete(emailLockKey); // Release email lock
    return Response.json({ error: 'Signup in progress for this username. Please try again.' }, { status: 409 });
  }
  await env.AUTH_KV.put(usernameLockKey, lockValue, { expirationTtl: LOCK_TTL_SECONDS });

  try {
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
  const accessExpiry = 15 * 60;
  let token: string;
  try {
    token = await signJWT({ uid, username: normalizedUsername }, env.JWT_SECRET, accessExpiry);
  } catch (e) {
    console.error('Signup: sign JWT failed:', e);
    return Response.json({ error: 'Signup failed. Please try again.' }, { status: 500 });
  }

  const refreshToken = generateRefreshToken();
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

  // Send verification email on signup (non-blocking)
  if (env.RESEND_API_KEY && env.FROM_EMAIL) {
    const verifyToken = crypto.randomUUID() + '-' + crypto.randomUUID();
    const verifyTtlSeconds = 24 * 60 * 60;
    const verificationRecord: EmailVerificationRecord = {
      uid,
      email: normalizedEmail,
      createdAt: now,
      expiresAt: now + (verifyTtlSeconds * 1000),
    };
    env.AUTH_KV.put(`verify:${verifyToken}`, JSON.stringify(verificationRecord), {
      expirationTtl: verifyTtlSeconds,
    }).then(() => {
      const appUrl = env.APP_URL || 'https://eternalos.app';
      const verifyUrl = `${appUrl}/verify-email?token=${verifyToken}`;
      const { html, text } = getEmailVerificationEmail(verifyUrl, normalizedUsername);
      return sendEmail(env.RESEND_API_KEY!, env.FROM_EMAIL!, {
        to: normalizedEmail,
        subject: 'Verify your EternalOS email',
        html,
        text,
      });
    }).catch((err) => console.error('Failed to send verification email:', err));
  }

    return Response.json({
      token,
      refreshToken,
      expiresIn: accessExpiry,
      user: {
        uid,
        username: normalizedUsername,
        email: normalizedEmail,
        emailVerified: false,
      },
    });
  } finally {
    // Always release signup locks (they auto-expire too, but clean up eagerly)
    await Promise.all([
      env.AUTH_KV.delete(emailLockKey).catch(() => {}),
      env.AUTH_KV.delete(usernameLockKey).catch(() => {}),
    ]);
  }
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

  // OAuth-only users have no password — cannot use email/password login
  if (!userRecord.passwordHash) {
    const providers = userRecord.oauthProviders?.map(p => p.provider).join(', ') || 'OAuth';
    return Response.json({ error: `This account uses ${providers} sign-in. Please use that method instead.` }, { status: 400 });
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
  // Access token: 15 minutes, Refresh token: 7 days
  const accessExpiry = 15 * 60; // 15 minutes in seconds
  let token: string;
  try {
    token = await signJWT(
      { uid: userRecord.uid, username: userRecord.username },
      env.JWT_SECRET,
      accessExpiry
    );
  } catch (jwtError) {
    console.error('JWT signing error:', jwtError);
    return Response.json({ error: 'Token generation error' }, { status: 500 });
  }

  // Generate refresh token
  const now = Date.now();
  const refreshToken = generateRefreshToken();
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
      emailVerified: userRecord.emailVerified || false,
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

  // Parse optional body for refresh token (fallback when session already expired from KV)
  const body = await request.json().catch(() => ({})) as { refreshToken?: string };

  // Get session to also delete refresh token
  const sessionJson = await env.AUTH_KV.get(`session:${token}`);
  if (sessionJson) {
    const session = JSON.parse(sessionJson) as SessionRecord;
    if (session.refreshToken) {
      await env.AUTH_KV.delete(`refresh:${session.refreshToken}`);
    }
  } else if (body.refreshToken) {
    // Session already expired from KV — use the client-provided refresh token
    await env.AUTH_KV.delete(`refresh:${body.refreshToken}`);
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
    familyId?: string; // Token family ID for reuse detection
    consumed?: boolean; // True if token was already used (reuse detection)
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

  // SECURITY: Token family reuse detection.
  // Each refresh token belongs to a "family" (identified by familyId).
  // If a refresh token is reused (already consumed), it means the token was
  // stolen — invalidate the entire family to boot the attacker.
  const familyId = refreshData.familyId || refreshToken; // backcompat: old tokens without familyId use themselves
  if (refreshData.consumed) {
    // This refresh token was already used! Possible token theft.
    // Invalidate the entire token family by marking a poison flag.
    await env.AUTH_KV.put(`refresh-family-revoked:${familyId}`, '1', {
      expirationTtl: 7 * 24 * 60 * 60,
    });
    // Clean up old tokens
    await env.AUTH_KV.delete(`refresh:${refreshToken}`);
    await env.AUTH_KV.delete(`session:${refreshData.accessToken}`);
    return Response.json({ error: 'Token reuse detected. All sessions revoked.' }, { status: 401 });
  }

  // Check if this token's family has been revoked
  const familyRevoked = await env.AUTH_KV.get(`refresh-family-revoked:${familyId}`);
  if (familyRevoked) {
    await env.AUTH_KV.delete(`refresh:${refreshToken}`);
    await env.AUTH_KV.delete(`session:${refreshData.accessToken}`);
    return Response.json({ error: 'Session revoked due to suspicious activity.' }, { status: 401 });
  }

  // Mark old refresh token as consumed (don't delete — keep for reuse detection)
  const consumedData = { ...refreshData, consumed: true };
  await env.AUTH_KV.put(`refresh:${refreshToken}`, JSON.stringify(consumedData), {
    expirationTtl: 60, // Keep for 60s to detect concurrent reuse, then auto-expire
  });
  // Delete old access token session
  await env.AUTH_KV.delete(`session:${refreshData.accessToken}`);

  // Generate new tokens
  const now = Date.now();
  // Access token: 15 minutes, Refresh token: 7 days
  const accessExpiry = 15 * 60; // 15 minutes in seconds
  const newAccessToken = await signJWT({ uid: refreshData.uid, username: refreshData.username }, env.JWT_SECRET, accessExpiry);
  const newRefreshToken = generateRefreshToken();
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

  // Store new refresh token (includes familyId for reuse detection)
  const newRefreshData = {
    uid: refreshData.uid,
    username: refreshData.username,
    accessToken: newAccessToken,
    expiresAt: now + (refreshExpiry * 1000),
    issuedAt: now,
    familyId, // Preserve the family ID across rotations
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

  // SECURITY: Per-address email rate limit — max 3 reset emails per hour
  // Prevents email bombing and abuse of the email-sending endpoint
  const emailRateLimitKey = `email-ratelimit:${normalizedEmail}`;
  const emailRateData = await env.AUTH_KV.get<number[]>(emailRateLimitKey, 'json');
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentSends = (emailRateData || []).filter(ts => ts > oneHourAgo);
  if (recentSends.length >= 3) {
    // Still return success to prevent email enumeration
    return Response.json({
      success: true,
      message: 'If an account with that email exists, a reset link has been generated.',
    });
  }

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

  // Track the email send
  recentSends.push(Date.now());
  await env.AUTH_KV.put(emailRateLimitKey, JSON.stringify(recentSends), { expirationTtl: 3600 });

  const userRecord = JSON.parse(userJson) as UserRecord;

  // OAuth-only users have no password — silently return success
  // (consistent with the non-enumeration pattern above)
  if (!userRecord.passwordHash && userRecord.oauthProviders?.length) {
    return Response.json({
      success: true,
      message: 'If an account with that email exists, a reset link has been generated.',
    });
  }

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

  const isDev = env.ENVIRONMENT === 'development';

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

// ============ Change Password (authenticated) ============

interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

/**
 * POST /api/auth/change-password
 * Change password for authenticated user
 */
export async function handleChangePassword(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  let body: ChangePasswordBody;
  try {
    body = await request.json() as ChangePasswordBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { currentPassword, newPassword } = body;

  if (!currentPassword || !newPassword) {
    return Response.json({ error: 'Current password and new password are required' }, { status: 400 });
  }

  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    return Response.json({ error: passwordError }, { status: 400 });
  }

  // Look up user by UID
  const uidIndexJson = await env.AUTH_KV.get(`uid:${auth.uid}`);
  if (!uidIndexJson) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  const { email } = JSON.parse(uidIndexJson) as { email: string };
  const userJson = await env.AUTH_KV.get(`user:${email}`);
  if (!userJson) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  const userRecord = JSON.parse(userJson) as UserRecord;

  // OAuth-only users can set their first password without providing a current one.
  // Users with an existing password must verify it first.
  if (userRecord.passwordHash) {
    const valid = await verifyPassword(currentPassword, userRecord.passwordHash);
    if (!valid) {
      return Response.json({ error: 'Current password is incorrect' }, { status: 401 });
    }
  }

  // Hash new password and update
  const newPasswordHash = await hashPassword(newPassword);
  const now = Date.now();

  const updatedUserRecord: UserRecord = {
    ...userRecord,
    passwordHash: newPasswordHash,
    passwordChangedAt: now,
  };

  await env.AUTH_KV.put(`user:${email}`, JSON.stringify(updatedUserRecord));

  // Generate new tokens so the user stays logged in
  const accessExpiry = 15 * 60;
  const token = await signJWT({ uid: auth.uid, username: userRecord.username }, env.JWT_SECRET, accessExpiry);
  const refreshToken = generateRefreshToken();
  const refreshExpiry = 7 * 24 * 60 * 60;

  const sessionRecord: SessionRecord = {
    uid: auth.uid,
    expiresAt: now + (accessExpiry * 1000),
    issuedAt: now,
    refreshToken,
    refreshExpiresAt: now + (refreshExpiry * 1000),
  };

  await env.AUTH_KV.put(`session:${token}`, JSON.stringify(sessionRecord), {
    expirationTtl: accessExpiry,
  });

  await env.AUTH_KV.put(`refresh:${refreshToken}`, JSON.stringify({
    uid: auth.uid,
    username: userRecord.username,
    accessToken: token,
    expiresAt: now + (refreshExpiry * 1000),
    issuedAt: now,
  }), {
    expirationTtl: refreshExpiry,
  });

  return Response.json({
    success: true,
    message: 'Password changed successfully.',
    token,
    refreshToken,
    expiresIn: accessExpiry,
  });
}

// ============ Change Username (authenticated) ============

interface ChangeUsernameBody {
  newUsername: string;
  password: string;
}

/**
 * POST /api/auth/change-username
 * Change username for authenticated user (requires password confirmation)
 */
export async function handleChangeUsername(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  let body: ChangeUsernameBody;
  try {
    body = await request.json() as ChangeUsernameBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { newUsername, password } = body;

  if (!newUsername || !password) {
    return Response.json({ error: 'New username and password are required' }, { status: 400 });
  }

  const usernameError = validateUsername(newUsername);
  if (usernameError) {
    return Response.json({ error: usernameError }, { status: 400 });
  }

  const normalizedNewUsername = sanitizeUsername(newUsername);

  // Look up user by UID
  const uidIndexJson = await env.AUTH_KV.get(`uid:${auth.uid}`);
  if (!uidIndexJson) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  const { email } = JSON.parse(uidIndexJson) as { email: string };
  const userJson = await env.AUTH_KV.get(`user:${email}`);
  if (!userJson) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  const userRecord = JSON.parse(userJson) as UserRecord;

  // Verify password (OAuth-only users still need password confirmation if they have one set)
  if (userRecord.passwordHash) {
    const valid = await verifyPassword(password, userRecord.passwordHash);
    if (!valid) {
      return Response.json({ error: 'Password is incorrect' }, { status: 401 });
    }
  } else if (userRecord.oauthProviders?.length) {
    // OAuth-only user — require them to set a password first for verification
    return Response.json({ error: 'Please set a password in account settings before changing your username' }, { status: 400 });
  } else {
    // No password and no OAuth — shouldn't happen, but fail safely
    return Response.json({ error: 'Account configuration error' }, { status: 500 });
  }

  // Check if same as current
  if (normalizedNewUsername === userRecord.username) {
    return Response.json({ error: 'New username is the same as current username' }, { status: 400 });
  }

  // SECURITY: Lock the new username to prevent concurrent claims
  const usernameLockKey = `signup-lock:username:${normalizedNewUsername}`;
  const lockValue = crypto.randomUUID();
  const existingLock = await env.AUTH_KV.get(usernameLockKey);
  if (existingLock) {
    return Response.json({ error: 'Username claim in progress. Please try again.' }, { status: 409 });
  }
  await env.AUTH_KV.put(usernameLockKey, lockValue, { expirationTtl: 30 });

  try {
    // Check if new username is taken
    const existingUsername = await env.AUTH_KV.get(`username:${normalizedNewUsername}`);
    if (existingUsername) {
      return Response.json({ error: 'Username already taken' }, { status: 409 });
    }

    const oldUsername = userRecord.username;

    // SECURITY: Set usernameChangedAt to invalidate old sessions that carry the stale username.
    // This prevents confusion if the old username is later claimed by another user.
    const updatedUserRecord: UserRecord = {
      ...userRecord,
      username: normalizedNewUsername,
      passwordChangedAt: Date.now(), // Reuse passwordChangedAt to invalidate all existing sessions
    };
    await env.AUTH_KV.put(`user:${email}`, JSON.stringify(updatedUserRecord));

    // Update username index: add new, delete old
    await env.AUTH_KV.put(`username:${normalizedNewUsername}`, JSON.stringify({ uid: auth.uid }));
    await env.AUTH_KV.delete(`username:${oldUsername}`);

    // Update the user's Durable Object profile with the new username
    const doId = env.USER_DESKTOP.idFromName(auth.uid);
    const stub = env.USER_DESKTOP.get(doId);
    await stub.fetch(new Request('http://internal/profile', {
      method: 'PATCH',
      body: JSON.stringify({ username: normalizedNewUsername }),
    }));

    // Issue new tokens with updated username
    const now = Date.now();
    const accessExpiry = 15 * 60;
    const token = await signJWT({ uid: auth.uid, username: normalizedNewUsername }, env.JWT_SECRET, accessExpiry);
    const refreshToken = generateRefreshToken();
    const refreshExpiry = 7 * 24 * 60 * 60;

    const sessionRecord: SessionRecord = {
      uid: auth.uid,
      expiresAt: now + (accessExpiry * 1000),
      issuedAt: now,
      refreshToken,
      refreshExpiresAt: now + (refreshExpiry * 1000),
    };

    await env.AUTH_KV.put(`session:${token}`, JSON.stringify(sessionRecord), {
      expirationTtl: accessExpiry,
    });

    await env.AUTH_KV.put(`refresh:${refreshToken}`, JSON.stringify({
      uid: auth.uid,
      username: normalizedNewUsername,
      accessToken: token,
      expiresAt: now + (refreshExpiry * 1000),
      issuedAt: now,
    }), {
      expirationTtl: refreshExpiry,
    });

    // Send notification email (non-blocking)
    if (env.RESEND_API_KEY && env.FROM_EMAIL) {
      const { html, text } = getUsernameChangeEmail(oldUsername, normalizedNewUsername);
      sendEmail(env.RESEND_API_KEY, env.FROM_EMAIL, {
        to: email,
        subject: 'Your EternalOS username has been changed',
        html,
        text,
      }).catch((err) => console.error('Failed to send username change email:', err));
    }

    return Response.json({
      success: true,
      message: 'Username changed successfully.',
      username: normalizedNewUsername,
      token,
      refreshToken,
      expiresIn: accessExpiry,
    });
  } finally {
    // Always release username lock
    await env.AUTH_KV.delete(usernameLockKey).catch(() => {});
  }
}

// ============ Email Verification ============

/**
 * POST /api/auth/send-verification
 * Send verification email to the authenticated user
 */
export async function handleSendVerification(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  // Look up user by UID
  const uidIndexJson = await env.AUTH_KV.get(`uid:${auth.uid}`);
  if (!uidIndexJson) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  const { email } = JSON.parse(uidIndexJson) as { email: string };
  const userJson = await env.AUTH_KV.get(`user:${email}`);
  if (!userJson) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  const userRecord = JSON.parse(userJson) as UserRecord;

  if (userRecord.emailVerified) {
    return Response.json({ error: 'Email is already verified' }, { status: 400 });
  }

  // SECURITY: Per-address rate limit — max 3 verification emails per hour
  const verifyRateLimitKey = `email-ratelimit:verify:${email}`;
  const verifyRateData = await env.AUTH_KV.get<number[]>(verifyRateLimitKey, 'json');
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentVerifySends = (verifyRateData || []).filter(ts => ts > oneHourAgo);
  if (recentVerifySends.length >= 3) {
    return Response.json({ error: 'Too many verification emails sent. Please try again later.' }, { status: 429 });
  }
  recentVerifySends.push(Date.now());
  await env.AUTH_KV.put(verifyRateLimitKey, JSON.stringify(recentVerifySends), { expirationTtl: 3600 });

  // Generate verification token
  const verifyToken = crypto.randomUUID() + '-' + crypto.randomUUID();
  const now = Date.now();
  const ttlSeconds = 24 * 60 * 60; // 24 hours

  const verificationRecord: EmailVerificationRecord = {
    uid: auth.uid,
    email,
    createdAt: now,
    expiresAt: now + (ttlSeconds * 1000),
  };

  await env.AUTH_KV.put(`verify:${verifyToken}`, JSON.stringify(verificationRecord), {
    expirationTtl: ttlSeconds,
  });

  // Build verification URL
  const appUrl = env.APP_URL || 'https://eternalos.app';
  const verifyUrl = `${appUrl}/verify-email?token=${verifyToken}`;

  const isDev = env.ENVIRONMENT === 'development';

  // Send verification email
  if (env.RESEND_API_KEY && env.FROM_EMAIL) {
    const { html, text } = getEmailVerificationEmail(verifyUrl, userRecord.username);
    const sent = await sendEmail(env.RESEND_API_KEY, env.FROM_EMAIL, {
      to: email,
      subject: 'Verify your EternalOS email',
      html,
      text,
    });

    if (!sent) {
      console.error(`Failed to send verification email to ${email}`);
    }
  } else if (isDev) {
    console.log(`[DEV] Email verification URL: ${verifyUrl}`);
  }

  return Response.json({
    success: true,
    message: 'Verification email sent. Please check your inbox.',
    ...(isDev ? { verifyToken, verifyUrl } : {}),
  });
}

/**
 * POST /api/auth/verify-email
 * Verify email address using token
 */
export async function handleVerifyEmail(request: Request, env: Env): Promise<Response> {
  let body: { token: string };
  try {
    body = await request.json() as { token: string };
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { token } = body;

  if (!token) {
    return Response.json({ error: 'Verification token is required' }, { status: 400 });
  }

  // Look up verification token
  const verifyJson = await env.AUTH_KV.get(`verify:${token}`);
  if (!verifyJson) {
    return Response.json({ error: 'Invalid or expired verification token' }, { status: 400 });
  }

  const verifyRecord = JSON.parse(verifyJson) as EmailVerificationRecord;

  // Check expiry
  if (Date.now() > verifyRecord.expiresAt) {
    await env.AUTH_KV.delete(`verify:${token}`);
    return Response.json({ error: 'Verification token has expired' }, { status: 400 });
  }

  // Get user record
  const userJson = await env.AUTH_KV.get(`user:${verifyRecord.email}`);
  if (!userJson) {
    await env.AUTH_KV.delete(`verify:${token}`);
    return Response.json({ error: 'Account no longer exists' }, { status: 400 });
  }

  const userRecord = JSON.parse(userJson) as UserRecord;

  if (userRecord.emailVerified) {
    await env.AUTH_KV.delete(`verify:${token}`);
    return Response.json({ success: true, message: 'Email is already verified.' });
  }

  // Mark email as verified
  const updatedUserRecord: UserRecord = {
    ...userRecord,
    emailVerified: true,
    emailVerifiedAt: Date.now(),
  };

  await env.AUTH_KV.put(`user:${verifyRecord.email}`, JSON.stringify(updatedUserRecord));

  // Delete the verification token (one-time use)
  await env.AUTH_KV.delete(`verify:${token}`);

  return Response.json({
    success: true,
    message: 'Email verified successfully!',
  });
}

// ============ Google OAuth ============

interface GoogleCallbackBody {
  code: string;
  redirectUri: string;
}

interface GoogleTokenResponse {
  access_token: string;
  id_token: string;
  expires_in: number;
  token_type: string;
  error?: string;
  error_description?: string;
}

interface GoogleUserInfo {
  id: string;       // Google subject ID
  email: string;
  verified_email: boolean;
  name: string;
  given_name?: string;
  picture?: string;
}

/**
 * POST /api/auth/google
 * Exchange a Google OAuth authorization code for EternalOS tokens.
 * - If the email matches an existing user, link the Google provider and log them in.
 * - If no user exists, create a new account (OAuth-only, no password).
 */
export async function handleGoogleCallback(request: Request, env: Env): Promise<Response> {
  let body: GoogleCallbackBody;
  try {
    body = await request.json() as GoogleCallbackBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { code, redirectUri } = body;
  if (!code || !redirectUri) {
    return Response.json({ error: 'Authorization code and redirect URI are required' }, { status: 400 });
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return Response.json({ error: 'Google OAuth is not configured' }, { status: 500 });
  }

  // Step 1: Exchange authorization code for Google tokens
  let googleTokens: GoogleTokenResponse;
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    googleTokens = await tokenResponse.json() as GoogleTokenResponse;

    if (googleTokens.error) {
      console.error('Google token exchange error:', googleTokens.error, googleTokens.error_description);
      return Response.json({ error: 'Failed to authenticate with Google. Please try again.' }, { status: 401 });
    }
  } catch (e) {
    console.error('Google token exchange failed:', e);
    return Response.json({ error: 'Failed to connect to Google. Please try again.' }, { status: 502 });
  }

  // Step 2: Fetch user info from Google
  let googleUser: GoogleUserInfo;
  try {
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${googleTokens.access_token}` },
    });

    if (!userInfoResponse.ok) {
      return Response.json({ error: 'Failed to get user info from Google' }, { status: 502 });
    }

    googleUser = await userInfoResponse.json() as GoogleUserInfo;
  } catch (e) {
    console.error('Google userinfo fetch failed:', e);
    return Response.json({ error: 'Failed to get user info from Google' }, { status: 502 });
  }

  if (!googleUser.email || !googleUser.verified_email) {
    return Response.json({ error: 'Google account must have a verified email address' }, { status: 400 });
  }

  const normalizedEmail = googleUser.email.toLowerCase().trim();
  const now = Date.now();

  // Step 3: Check if user exists by Google provider ID or by email
  const oauthIndexJson = await env.AUTH_KV.get(`oauth:google:${googleUser.id}`);
  let userRecord: UserRecord | null = null;
  let isNewUser = false;

  if (oauthIndexJson) {
    // Returning Google user — find their account
    const { uid } = JSON.parse(oauthIndexJson) as { uid: string };
    const uidIndexJson = await env.AUTH_KV.get(`uid:${uid}`);
    if (uidIndexJson) {
      const { email } = JSON.parse(uidIndexJson) as { email: string };
      const userJson = await env.AUTH_KV.get(`user:${email}`);
      if (userJson) {
        userRecord = JSON.parse(userJson) as UserRecord;
      }
    }
  }

  if (!userRecord) {
    // Check if an email/password user exists with the same email
    const existingUserJson = await env.AUTH_KV.get(`user:${normalizedEmail}`);

    if (existingUserJson) {
      // Auto-link: existing user, add Google provider
      userRecord = JSON.parse(existingUserJson) as UserRecord;
      const providers = userRecord.oauthProviders || [];
      const alreadyLinked = providers.some(p => p.provider === 'google' && p.providerId === googleUser.id);

      if (!alreadyLinked) {
        providers.push({
          provider: 'google',
          providerId: googleUser.id,
          connectedAt: now,
          email: normalizedEmail,
        });
        userRecord.oauthProviders = providers;
        // Also verify email since Google verified it
        if (!userRecord.emailVerified) {
          userRecord.emailVerified = true;
          userRecord.emailVerifiedAt = now;
        }
        await env.AUTH_KV.put(`user:${normalizedEmail}`, JSON.stringify(userRecord));
        await env.AUTH_KV.put(`oauth:google:${googleUser.id}`, JSON.stringify({ uid: userRecord.uid }));
      }
    } else {
      // New user via Google OAuth — create account
      isNewUser = true;
      const uid = crypto.randomUUID();

      // Generate username from Google name
      let baseUsername = (googleUser.given_name || googleUser.name || 'user')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '')
        .slice(0, 15);
      if (baseUsername.length < 3) baseUsername = 'user';

      // Ensure uniqueness
      let username = baseUsername;
      let suffix = 1;
      while (await env.AUTH_KV.get(`username:${username}`)) {
        username = `${baseUsername}${suffix}`;
        suffix++;
        if (suffix > 100) {
          username = `user_${crypto.randomUUID().slice(0, 8)}`;
          break;
        }
      }

      const oauthProvider: OAuthProvider = {
        provider: 'google',
        providerId: googleUser.id,
        connectedAt: now,
        email: normalizedEmail,
      };

      userRecord = {
        uid,
        email: normalizedEmail,
        // No passwordHash — OAuth-only account
        username,
        createdAt: now,
        emailVerified: true,
        emailVerifiedAt: now,
        oauthProviders: [oauthProvider],
      };

      // Store user data
      await env.AUTH_KV.put(`user:${normalizedEmail}`, JSON.stringify(userRecord));
      await env.AUTH_KV.put(`username:${username}`, JSON.stringify({ uid }));
      await env.AUTH_KV.put(`uid:${uid}`, JSON.stringify({ email: normalizedEmail }));
      await env.AUTH_KV.put(`oauth:google:${googleUser.id}`, JSON.stringify({ uid }));
      await env.AUTH_KV.put(`user_index:${uid}`, normalizedEmail);

      // Initialize Durable Object with profile and default items
      const doId = env.USER_DESKTOP.idFromName(uid);
      const stub = env.USER_DESKTOP.get(doId);

      const displayName = googleUser.name || username;
      await stub.fetch(new Request('http://internal/profile', {
        method: 'POST',
        body: JSON.stringify({
          uid,
          username,
          displayName,
          wallpaper: 'default',
          createdAt: now,
          isNewUser: true,
        }),
      }));

      // Create a default welcome item
      await stub.fetch(new Request('http://internal/items', {
        method: 'POST',
        body: JSON.stringify({
          type: 'text',
          name: 'Welcome.txt',
          parentId: null,
          position: { x: 0, y: 0 },
          isPublic: true,
          textContent: `Welcome to EternalOS, ${displayName}!\n\nYour personal desktop is ready.\n\n• Double-click items to open them\n• Right-click for context menus\n• Drop files to upload\n• Special menu → Appearance for customization\n\nYour public URL: eternalos.app/@${username}`,
        }),
      }));
    }
  }

  if (!userRecord) {
    return Response.json({ error: 'Failed to authenticate. Please try again.' }, { status: 500 });
  }

  // Step 4: Issue EternalOS tokens (same flow as login/signup)
  const accessExpiry = 15 * 60;
  const token = await signJWT({ uid: userRecord.uid, username: userRecord.username }, env.JWT_SECRET, accessExpiry);
  const refreshTokenValue = generateRefreshToken();
  const refreshExpiry = 7 * 24 * 60 * 60;

  const sessionRecord: SessionRecord = {
    uid: userRecord.uid,
    expiresAt: now + (accessExpiry * 1000),
    issuedAt: now,
    refreshToken: refreshTokenValue,
    refreshExpiresAt: now + (refreshExpiry * 1000),
  };

  await env.AUTH_KV.put(`session:${token}`, JSON.stringify(sessionRecord), {
    expirationTtl: accessExpiry,
  });

  await env.AUTH_KV.put(`refresh:${refreshTokenValue}`, JSON.stringify({
    uid: userRecord.uid,
    username: userRecord.username,
    accessToken: token,
    expiresAt: now + (refreshExpiry * 1000),
    issuedAt: now,
  }), {
    expirationTtl: refreshExpiry,
  });

  return Response.json({
    token,
    refreshToken: refreshTokenValue,
    expiresIn: accessExpiry,
    isNewUser,
    user: {
      uid: userRecord.uid,
      username: userRecord.username,
      email: userRecord.email,
      emailVerified: userRecord.emailVerified ?? false,
    },
  });
}
