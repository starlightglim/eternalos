// Google OAuth Callback Page
// Handles the redirect back from Google after user consents.
// Exchanges the authorization code for EternalOS tokens via the backend.

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { verifyOAuthState, getOAuthRedirectUri } from '../utils/googleOAuth'
import styles from './AuthPage.module.css'

export function GoogleAuthCallback() {
  const [error, setError] = useState<string | null>(null)
  const { googleLogin } = useAuthStore()
  const navigate = useNavigate()

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    const errorParam = params.get('error')

    // Handle Google errors (user cancelled, access denied, etc.)
    if (errorParam) {
      if (errorParam === 'access_denied') {
        navigate('/login', { replace: true })
      } else {
        setError(`Google sign-in failed: ${errorParam}`)
      }
      return
    }

    if (!code || !state) {
      setError('Invalid callback. Missing authorization code.')
      return
    }

    // Verify CSRF state token
    if (!verifyOAuthState(state)) {
      setError('Security check failed. Please try signing in again.')
      return
    }

    // Exchange code for tokens
    const exchangeCode = async () => {
      try {
        await googleLogin(code, getOAuthRedirectUri())
        navigate('/desktop', { replace: true })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Google sign-in failed'
        // Strip HTTP status prefix if present (e.g., "401 Failed to authenticate...")
        const cleanMessage = message.replace(/^\d{3}\s+/, '')
        setError(cleanMessage)
      }
    }

    exchangeCode()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className={styles.authContainer}>
        <div className={styles.authWindow}>
          <div className={styles.titleBar}>
            <span className={styles.titleText}>Sign In</span>
          </div>
          <div className={styles.content}>
            <div className={styles.logo}>
              <span className={styles.logoText}>EternalOS</span>
            </div>
            <div className={styles.error}>{error}</div>
            <button
              className={styles.submitButton}
              onClick={() => navigate('/login', { replace: true })}
              style={{ marginTop: 16 }}
            >
              Back to Login
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Loading state while exchanging the code
  return (
    <div className={styles.authContainer}>
      <div className={styles.authWindow}>
        <div className={styles.titleBar}>
          <span className={styles.titleText}>Sign In</span>
        </div>
        <div className={styles.content}>
          <div className={styles.logo}>
            <span className={styles.logoText}>EternalOS</span>
          </div>
          <p style={{
            fontFamily: 'var(--font-chicago)',
            fontSize: 11,
            textAlign: 'center',
            color: 'var(--shadow)',
          }}>
            Signing in with Google...
          </p>
        </div>
      </div>
    </div>
  )
}
