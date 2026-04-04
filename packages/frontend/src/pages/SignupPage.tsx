// Signup Page - Classic Mac OS styled registration
import { useState, type FormEvent, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { isApiConfigured } from '../services/api'
import { getGoogleClientId, redirectToGoogle } from '../utils/googleOAuth'
import styles from './AuthPage.module.css'

export function SignupPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [username, setUsername] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const { signup, loading, error, clearError, user } = useAuthStore()
  const navigate = useNavigate()

  // Set document title
  useEffect(() => {
    document.title = 'Create Your Desktop | EternalOS'
    return () => { document.title = 'EternalOS' }
  }, [])

  // If already logged in, redirect to desktop
  useEffect(() => {
    if (user) {
      navigate('/desktop', { replace: true })
    }
  }, [user, navigate])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    clearError()
    setLocalError(null)

    if (!isApiConfigured) {
      // Demo mode - navigate to demo user's desktop
      navigate('/@demo', { replace: true })
      return
    }

    // Validate passwords match
    if (password !== confirmPassword) {
      setLocalError('Passwords do not match')
      return
    }

    // Validate password strength (must match backend: 8+ chars with uppercase, lowercase, number)
    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters')
      return
    }

    try {
      await signup(email, password, username)
      // Navigation happens via useEffect when user state updates
    } catch (err) {
      // Error is handled by the store
      console.error('Signup error:', err)
    }
  }

  const displayError = localError || error

  // If API not configured, show demo mode notice
  if (!isApiConfigured) {
    return (
      <div className={styles.authContainer}>
        <div className={styles.authWindow}>
          <div className={styles.titleBar}>
            <span className={styles.titleText}>Sign Up</span>
          </div>
          <div className={styles.content}>
            <div className={styles.logo}>
              <span className={styles.logoText}>EternalOS</span>
            </div>

            <div className={styles.mockModeNotice}>
              API not configured. Running in demo mode.
            </div>

            <form className={styles.form} onSubmit={handleSubmit}>
              <button type="submit" className={styles.submitButton}>
                Enter Demo Mode
              </button>
            </form>

            <div className={styles.linkSection}>
              <span>Already have an account? </span>
              <Link to="/login" className={styles.link}>Log In</Link>
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
          <span className={styles.titleText}>Sign Up</span>
        </div>
        <div className={styles.content}>
          <div className={styles.logo}>
            <span className={styles.logoText}>EternalOS</span>
          </div>

          {displayError && <div className={styles.error}>{displayError}</div>}

          <form className={styles.form} onSubmit={handleSubmit}>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="username">Username</label>
              <input
                id="username"
                type="text"
                className={styles.input}
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                placeholder="your-unique-username"
                required
                autoComplete="username"
                pattern="[a-zA-Z0-9_]+"
                minLength={3}
                maxLength={20}
              />
            </div>

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
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                className={styles.input}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                minLength={8}
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
              />
            </div>

            <button
              type="submit"
              className={styles.submitButton}
              disabled={loading}
            >
              {loading ? 'Creating account...' : 'Create Account'}
            </button>
          </form>

          {getGoogleClientId() && (
            <>
              <div className={styles.divider}>
                <span className={styles.dividerText}>or</span>
              </div>
              <button
                type="button"
                className={styles.googleButton}
                onClick={redirectToGoogle}
              >
                <svg className={styles.googleIcon} viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Sign up with Google
              </button>
            </>
          )}

          <div className={styles.linkSection}>
            <span>Already have an account? </span>
            <Link to="/login" className={styles.link}>Log In</Link>
          </div>
        </div>
      </div>
    </div>
  )
}
