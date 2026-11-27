/**
 * Password rules — mirrors `validatePassword` in
 * packages/worker/src/routes/auth.ts (the server is the authority; keep the
 * two in sync). Used by SignupPage and ResetPasswordPage to show rule hints
 * and block submits the server would reject anyway.
 */

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

export interface PasswordRule {
  id: 'length' | 'lowercase' | 'uppercase' | 'digit'
  /** Short hint shown next to the field. */
  label: string
  /** Full sentence used when the rule blocks a submit (matches server wording). */
  message: string
  test: (password: string) => boolean
}

export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    id: 'length',
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    test: (p) => p.length >= PASSWORD_MIN_LENGTH,
  },
  {
    id: 'lowercase',
    label: 'A lowercase letter',
    message: 'Password must contain at least one lowercase letter',
    test: (p) => /[a-z]/.test(p),
  },
  {
    id: 'uppercase',
    label: 'An uppercase letter',
    message: 'Password must contain at least one uppercase letter',
    test: (p) => /[A-Z]/.test(p),
  },
  {
    id: 'digit',
    label: 'A number',
    message: 'Password must contain at least one number',
    test: (p) => /[0-9]/.test(p),
  },
]

export interface PasswordRuleResult {
  id: PasswordRule['id']
  label: string
  met: boolean
}

/** Every rule with whether `password` meets it, in display order. */
export function checkPasswordRules(password: string): PasswordRuleResult[] {
  return PASSWORD_RULES.map((rule) => ({ id: rule.id, label: rule.label, met: rule.test(password) }))
}

/**
 * First failing rule's message, or null when the password is acceptable.
 * Same order and wording as the server, so the user sees one consistent error.
 */
export function validatePassword(password: string): string | null {
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be ${PASSWORD_MAX_LENGTH} characters or less`
  }
  const failed = PASSWORD_RULES.find((rule) => !rule.test(password))
  return failed ? failed.message : null
}
