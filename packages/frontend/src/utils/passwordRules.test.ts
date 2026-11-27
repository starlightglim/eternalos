import { describe, expect, it } from 'vitest'
import { checkPasswordRules, validatePassword, PASSWORD_MAX_LENGTH } from './passwordRules'

describe('validatePassword', () => {
  it('accepts a password that meets every server rule', () => {
    expect(validatePassword('Abcdefg1')).toBeNull()
  })

  it('rejects short passwords first', () => {
    expect(validatePassword('Ab1')).toBe('Password must be at least 8 characters')
    expect(validatePassword('')).toBe('Password must be at least 8 characters')
  })

  it('rejects passwords over the max length', () => {
    expect(validatePassword('Aa1' + 'x'.repeat(PASSWORD_MAX_LENGTH))).toBe(
      `Password must be ${PASSWORD_MAX_LENGTH} characters or less`,
    )
    expect(validatePassword('Aa1' + 'x'.repeat(PASSWORD_MAX_LENGTH - 3))).toBeNull()
  })

  it('requires lowercase, uppercase and a digit in server order', () => {
    expect(validatePassword('ABCDEFG1')).toBe('Password must contain at least one lowercase letter')
    expect(validatePassword('abcdefg1')).toBe('Password must contain at least one uppercase letter')
    expect(validatePassword('Abcdefgh')).toBe('Password must contain at least one number')
  })

  it('does not count non-ASCII letters as upper/lower case (matches server regex)', () => {
    expect(validatePassword('ÄÖÜÄÖÜ12')).toBe('Password must contain at least one lowercase letter')
  })
})

describe('checkPasswordRules', () => {
  it('reports each rule in display order', () => {
    expect(checkPasswordRules('abc1').map((r) => [r.id, r.met])).toEqual([
      ['length', false],
      ['lowercase', true],
      ['uppercase', false],
      ['digit', true],
    ])
  })

  it('marks every rule met for a strong password', () => {
    expect(checkPasswordRules('Str0ngPassword').every((r) => r.met)).toBe(true)
  })
})
