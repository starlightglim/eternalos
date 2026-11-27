// Inline password rule checklist for SignupPage / ResetPasswordPage.
// Rules come from utils/passwordRules (mirrors the server's validatePassword).
import { checkPasswordRules } from '../utils/passwordRules'
import styles from './AuthPage.module.css'

interface PasswordRuleHintsProps {
  /** Referenced by the password input's aria-describedby. */
  id: string
  password: string
}

export function PasswordRuleHints({ id, password }: PasswordRuleHintsProps) {
  const rules = checkPasswordRules(password)
  return (
    <ul id={id} className={styles.ruleList} aria-label="Password requirements">
      {rules.map((rule) => (
        <li
          key={rule.id}
          className={rule.met ? styles.ruleMet : styles.ruleUnmet}
          data-rule={rule.id}
          data-met={rule.met ? 'true' : 'false'}
        >
          <span className={styles.ruleMark} aria-hidden="true">{rule.met ? '✓' : '•'}</span>
          {rule.label}
          <span className={styles.srOnly}>{rule.met ? ' (met)' : ' (not met)'}</span>
        </li>
      ))}
    </ul>
  )
}
