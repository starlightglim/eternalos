// Forgot Password Page - Classic Mac OS styled password recovery
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { isApiConfigured, forgotPassword } from '../services/api'
import { useDocumentMeta } from '../hooks/useDocumentMeta'
import styles from './AuthPage.module.css'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [resetUrl, setResetUrl] = useState<string | null>(null)

  useDocumentMeta({ title: 'Forgot Password | EternalOS' })

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const response = await forgotPassword(email)
      setSuccess(true)
      // In development mode, we get the reset URL directly
      if (response.resetUrl) {
        setResetUrl(response.resetUrl)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send reset link')
    } finally {
      setLoading(false)
    }
  }

  // If API not configured, show demo mode notice
  if (!isApiConfigured) {
    return (
      <div className={styles.authContainer}>
        <div className={styles.authWindow}>
          <div className={styles.titleBar}>
            <span className={styles.titleText}>Forgot Password</span>
          </div>
          <div className={styles.content}>
            <div className={styles.logo}>
              <span className={styles.logoText}>EternalOS</span>
            </div>

            <div className={styles.mockModeNotice}>
              API not configured. Password reset not available in demo mode.
            </div>

            <div className={styles.linkSection}>
              <Link to="/login" className={styles.link}>Back to Login</Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Success state
  if (success) {
    return (
      <div className={styles.authContainer}>
        <div className={styles.authWindow}>
          <div className={styles.titleBar}>
            <span className={styles.titleText}>Forgot Password</span>
          </div>
          <div className={styles.content}>
            <div className={styles.logo}>
              <span className={styles.logoText}>EternalOS</span>
            </div>

            <div className={styles.successMessage}>
              If an account with that email exists, a password reset link has been generated.
            </div>

            {resetUrl && (
              <div className={styles.devNotice}>
                <strong>Development Mode:</strong>
                <br />
                <Link to={resetUrl} className={styles.link}>
                  Click here to reset your password
                </Link>
              </div>
            )}

            <div className={styles.linkSection}>
              <Link to="/login" className={styles.link}>Back to Login</Link>
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
          <span className={styles.titleText}>Forgot Password</span>
        </div>
        <div className={styles.content}>
          <div className={styles.logo}>
            <span className={styles.logoText}>EternalOS</span>
          </div>

          <p className={styles.instructions}>
            Enter your email address and we'll send you a link to reset your password.
          </p>

          {error && <div className={styles.error} role="alert">{error}</div>}

          <form className={styles.form} onSubmit={handleSubmit}>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                className={styles.input}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                autoFocus
              />
            </div>

            <button
              type="submit"
              className={styles.submitButton}
              disabled={loading}
            >
              {loading ? 'Sending...' : 'Send Reset Link'}
            </button>
          </form>

          <div className={styles.linkSection}>
            <span>Remember your password? </span>
            <Link to="/login" className={styles.link}>Log In</Link>
          </div>
        </div>
      </div>
    </div>
  )
}
