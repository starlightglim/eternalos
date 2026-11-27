import { expect, test } from 'vitest';
import { ApiError } from '../../services/transport';
import { errorText, isAbortError } from './bazaarRequests';

test('isAbortError recognizes cancelled requests only', () => {
  expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
  expect(isAbortError(new Error('boom'))).toBe(false);
  expect(isAbortError(null)).toBe(false);
});

test('errorText prefers the server detail and explains network failures', () => {
  expect(errorText(new ApiError(500, 'Failed to browse'), 'x')).toBe('Failed to browse');
  expect(errorText(new TypeError('Failed to fetch'), 'x')).toMatch(/Network error/);
  expect(errorText(new Error('Session expired'), 'x')).toBe('Session expired');
  expect(errorText('nope', 'fallback')).toBe('fallback');
});
