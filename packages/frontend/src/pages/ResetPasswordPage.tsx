// Reset Password Page - Classic Mac OS styled password reset
import { useState, type FormEvent, useEffect } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { isApiConfigured, resetPassword } from '../services/api'
import styles from './AuthPage.module.css'

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token') || ''

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // Set document title
  useEffect(() => {
    document.title = 'Reset Password | EternalOS'
    return () => { document.title = 'EternalOS' }
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    // Client-side validation
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)

    try {
      await resetPassword(token, newPassword)
      setSuccess(true)
      // Redirect to login after 3 seconds
      setTimeout(() => {
        navigate('/login')
      }, 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password')
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
            <span className={styles.titleText}>Reset Password</span>
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

  // No token provided
  if (!token) {
    return (
      <div className={styles.authContainer}>
        <div className={styles.authWindow}>
          <div className={styles.titleBar}>
            <span className={styles.titleText}>Reset Password</span>
          </div>
          <div className={styles.content}>
            <div className={styles.logo}>
              <span className={styles.logoText}>EternalOS</span>
            </div>

            <div className={styles.error}>
              Invalid or missing reset token. Please request a new password reset link.
            </div>

            <div className={styles.linkSection}>
              <Link to="/forgot-password" className={styles.link}>Request New Reset Link</Link>
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
            <span className={styles.titleText}>Reset Password</span>
          </div>
          <div className={styles.content}>
            <div className={styles.logo}>
              <span className={styles.logoText}>EternalOS</span>
            </div>

            <div className={styles.successMessage}>
              Your password has been reset successfully!
              <br /><br />
              Redirecting to login...
            </div>

            <div className={styles.linkSection}>
              <Link to="/login" className={styles.link}>Go to Login</Link>
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
          <span className={styles.titleText}>Reset Password</span>
        </div>
        <div className={styles.content}>
          <div className={styles.logo}>
            <span className={styles.logoText}>EternalOS</span>
          </div>

          <p className={styles.instructions}>
            Enter your new password below.
          </p>

          {error && <div className={styles.error}>{error}</div>}

          <form className={styles.form} onSubmit={handleSubmit}>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="newPassword">New Password</label>
              <input
                id="newPassword"
                type="password"
                className={styles.input}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                autoComplete="new-password"
                autoFocus
                minLength={6}
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="confirmPassword">Confirm Password</label>
              <input
                id="confirmPassword"
                type="password"
                className={styles.input}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                minLength={6}
              />
            </div>

            <button
              type="submit"
              className={styles.submitButton}
              disabled={loading}
            >
              {loading ? 'Resetting...' : 'Reset Password'}
            </button>
          </form>

          <div className={styles.linkSection}>
            <Link to="/login" className={styles.link}>Back to Login</Link>
          </div>
        </div>
      </div>
    </div>
  )
}
