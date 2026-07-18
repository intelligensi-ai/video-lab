import js from '@eslint/js';
import ts from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
  { ignores: ['**/dist/**'] },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser,
      parserOptions: { project: false },
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly', setTimeout: 'readonly', fetch: 'readonly', TextEncoder: 'readonly', localStorage: 'readonly', RequestInit: 'readonly', File: 'readonly', crypto: 'readonly', navigator: 'readonly', location: 'readonly', document: 'readonly' },
    },
    plugins: { '@typescript-eslint': ts },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
];
