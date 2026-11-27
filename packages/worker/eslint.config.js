import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Worker lint config. Reuses the ESLint packages installed for the frontend
// (hoisted to the repo root). Rules that fail on today's source are turned
// off below with a TODO so a follow-up can fix the code and enable them.
export default defineConfig([
  globalIgnores(['dist', '.wrangler', 'test/fixtures']),
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.serviceworker,
    },
    rules: {
      // TODO: fix the existing violations in src/ and turn these back on.
      '@typescript-eslint/no-explicit-any': 'off', // 21 today
      '@typescript-eslint/no-unused-vars': 'off', // 18 today
      'prefer-const': 'off', // 4 today
      'no-useless-escape': 'off', // 2 today
      // Sanitizers match control characters on purpose (9 today); review each
      // and add eslint-disable-next-line before re-enabling.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['test/**/*.mjs', '*.js', '*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
    rules: {
      // TODO: fix the existing violations in test/ and turn these back on.
      'no-regex-spaces': 'off', // 7 today
      'no-unused-vars': 'off', // 1 today
      'no-useless-escape': 'off', // 1 today
    },
  },
])
