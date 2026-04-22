import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import promise from 'eslint-plugin-promise';
import security from 'eslint-plugin-security';
import unicorn from 'eslint-plugin-unicorn';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'test/**', 'scripts/**', '*.config.ts', '*.config.js'] },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', project: './tsconfig.json' },
      globals: { console: 'readonly', process: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', crypto: 'readonly', TextEncoder: 'readonly', fetch: 'readonly' },
    },
    plugins: { '@typescript-eslint': tseslint, promise, security, unicorn },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...promise.configs.recommended.rules,
      ...security.configs.recommended.rules,
      complexity: ['error', { max: 15 }],
      'max-depth': ['error', 4],
      'max-params': ['warn', 5],
      'no-duplicate-imports': 'error',
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'unicorn/prefer-node-protocol': 'error',
      'security/detect-object-injection': 'off',
    },
  },
  prettier,
];
