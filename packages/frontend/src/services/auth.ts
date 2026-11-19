/**
 * Auth domain client — signup / login / OAuth / logout, password reset and
 * rotation, username changes, and email verification.
 */

import {
  API_URL,
  apiRequest,
  clearFileToken,
  getAuthToken,
  getRefreshToken,
  setAuthToken,
  setRefreshToken,
} from './transport';

// ============ Auth API ============

export interface SignupResponse {
  token: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    uid: string;
    username: string;
    email: string;
    emailVerified?: boolean;
  };
  /** Plaintext recovery codes — server returns these exactly once at signup. */
  recoveryCodes?: string[];
}

export interface LoginResponse {
  token: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    uid: string;
    username: string;
    email: string;
    emailVerified?: boolean;
  };
}

export async function signup(
  email: string,
  password: string,
  username: string,
  turnstileToken?: string | null,
): Promise<SignupResponse> {
  return apiRequest<SignupResponse>('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password, username, turnstileToken }),
  });
}

export async function login(
  email: string,
  password: string,
  turnstileToken?: string | null,
): Promise<LoginResponse> {
  return apiRequest<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, turnstileToken }),
  });
}

export interface GoogleLoginResponse extends LoginResponse {
  isNewUser: boolean;
}

export async function googleLogin(code: string, redirectUri: string): Promise<GoogleLoginResponse> {
  return apiRequest<GoogleLoginResponse>('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ code, redirectUri }),
  });
}

export async function logout(): Promise<void> {
  // Use direct fetch (not apiRequest) to avoid triggering token refresh on expired sessions
  const authToken = getAuthToken();
  if (authToken) {
    try {
      await fetch(`${API_URL}/api/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        // Send refresh token so backend can clean it up even if session already expired
        body: JSON.stringify({ refreshToken: getRefreshToken() }),
      });
    } catch { /* ignore network errors during logout */ }
  }
  setAuthToken(null);
  setRefreshToken(null);
  clearFileToken();
}

// ============ Password Reset API ============

export interface ForgotPasswordResponse {
  success: boolean;
  message: string;
  resetToken?: string; // Only in development
  resetUrl?: string; // Only in development
}

export async function forgotPassword(email: string): Promise<ForgotPasswordResponse> {
  return apiRequest<ForgotPasswordResponse>('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export interface ResetPasswordResponse {
  success: boolean;
  message: string;
}

export async function resetPassword(
  token: string,
  newPassword: string
): Promise<ResetPasswordResponse> {
  return apiRequest<ResetPasswordResponse>('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  });
}

// ============ Change Password API ============

export interface ChangePasswordResponse {
  success: boolean;
  message: string;
  token: string;
  refreshToken: string;
  expiresIn: number;
}

export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<ChangePasswordResponse> {
  return apiRequest<ChangePasswordResponse>('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

// ============ Change Username API ============

export interface ChangeUsernameResponse {
  success: boolean;
  message: string;
  username: string;
  token: string;
  refreshToken: string;
  expiresIn: number;
}

export async function changeUsername(
  newUsername: string,
  password: string
): Promise<ChangeUsernameResponse> {
  return apiRequest<ChangeUsernameResponse>('/api/auth/change-username', {
    method: 'POST',
    body: JSON.stringify({ newUsername, password }),
  });
}

// ============ Email Verification API ============

export interface SendVerificationResponse {
  success: boolean;
  message: string;
}

export async function sendVerificationEmail(): Promise<SendVerificationResponse> {
  return apiRequest<SendVerificationResponse>('/api/auth/send-verification', {
    method: 'POST',
  });
}

export interface VerifyEmailResponse {
  success: boolean;
  message: string;
}

export async function verifyEmail(token: string): Promise<VerifyEmailResponse> {
  return apiRequest<VerifyEmailResponse>('/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}
