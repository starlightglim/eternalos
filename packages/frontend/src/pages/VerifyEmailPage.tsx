// Verify Email Page - Handles email verification token from link
import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { isApiConfigured, verifyEmail } from '../services/api'
import { useAuthStore } from '../stores/authStore'
import styles from './AuthPage.module.css'

export function VerifyEmailPage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const setEmailVerified = useAuthStore((s) => s.setEmailVerified)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    document.title = 'Verify Email | EternalOS'
    return () => { document.title = 'EternalOS' }
  }, [])

  useEffect(() => {
    if (!token || !isApiConfigured) {
      setLoading(false)
      return
    }

    verifyEmail(token)
      .then(() => {
        setSuccess(true)
        setEmailVerified(true)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Verification failed')
      })
      .finally(() => setLoading(false))
  }, [token, setEmailVerified])

  if (!isApiConfigured) {
    return (
      <div className={styles.authContainer}>
        <div className={styles.authWindow}>
          <div className={styles.titleBar}>
            <span className={styles.titleText}>Verify Email</span>
          </div>
          <div className={styles.content}>
            <div className={styles.logo}>
              <span className={styles.logoText}>EternalOS</span>
            </div>
            <div className={styles.mockModeNotice}>
              API not configured. Email verification not available in demo mode.
            </div>
            <div className={styles.linkSection}>
              <Link to="/login" className={styles.link}>Back to Login</Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!token) {
    return (
      <div className={styles.authContainer}>
        <div className={styles.authWindow}>
          <div className={styles.titleBar}>
            <span className={styles.titleText}>Verify Email</span>
          </div>
          <div className={styles.content}>
            <div className={styles.logo}>
              <span className={styles.logoText}>EternalOS</span>
            </div>
            <div className={styles.error}>
              Invalid or missing verification token.
            </div>
            <div className={styles.linkSection}>
              <Link to="/desktop" className={styles.link}>Go to Desktop</Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.authContainer}>
      <div className={styles.authWindow}>
        <div className={styles.titleBar}>
          <span className={styles.titleText}>Verify Email</span>
        </div>
        <div className={styles.content}>
          <div className={styles.logo}>
            <span className={styles.logoText}>EternalOS</span>
          </div>

          {loading && (
            <p className={styles.instructions}>Verifying your email address...</p>
          )}

          {error && (
            <>
              <div className={styles.error}>{error}</div>
              <div className={styles.linkSection}>
                <Link to="/desktop" className={styles.link}>Go to Desktop</Link>
              </div>
            </>
          )}

          {success && (
            <>
              <div className={styles.successMessage}>
                Your email has been verified successfully!
              </div>
              <div className={styles.linkSection}>
                <Link to="/desktop" className={styles.link}>Go to Desktop</Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
