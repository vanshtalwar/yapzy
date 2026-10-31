// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Shared flat config. Type-aware rules need the package directory so the
 * TypeScript project service resolves that package's tsconfig.json.
 *
 * @param {{ tsconfigRootDir: string }} options
 */
export function createEslintConfig({ tsconfigRootDir }) {
  return defineConfig(
    { ignores: ['**/dist/**', '**/.next/**', '**/coverage/**', '**/.turbo/**'] },
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        globals: { ...globals.node },
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      plugins: { 'simple-import-sort': simpleImportSort },
      rules: {
        'simple-import-sort/imports': 'error',
        'simple-import-sort/exports': 'error',
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        'no-console': 'error',
      },
    },
    {
      // Plain JS config files are not part of any tsconfig project.
      files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
      extends: [tseslint.configs.disableTypeChecked],
    },
    {
      files: ['**/*.test.ts', '**/*.spec.ts'],
      rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
    },
    prettier,
  );
}
