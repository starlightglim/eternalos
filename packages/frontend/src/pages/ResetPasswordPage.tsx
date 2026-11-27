// Reset Password Page - Classic Mac OS styled password reset
import { useState, type FormEvent, useEffect, useRef } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { isApiConfigured, resetPassword } from '../services/api'
import { useDocumentMeta } from '../hooks/useDocumentMeta'
import { validatePassword, PASSWORD_MAX_LENGTH } from '../utils/passwordRules'
import { PasswordRuleHints } from './PasswordRuleHints'
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

  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useDocumentMeta({ title: 'Reset Password | EternalOS' })

  // Cancel the post-success redirect if the user leaves first
  useEffect(() => () => {
    if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current)
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    // Client-side validation (mirrors the server rules in routes/auth.ts)
    const passwordError = validatePassword(newPassword)
    if (passwordError) {
      setError(passwordError)
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
      redirectTimerRef.current = setTimeout(() => {
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

            <div className={styles.error} role="alert">
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

          {error && <div className={styles.error} role="alert">{error}</div>}

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
                minLength={8}
                maxLength={PASSWORD_MAX_LENGTH}
                aria-describedby="password-rules"
              />
              <PasswordRuleHints id="password-rules" password={newPassword} />
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
                minLength={8}
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
