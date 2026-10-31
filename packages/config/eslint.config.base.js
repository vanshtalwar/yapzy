// @ts-check
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Shared flat config. Type-aware rules need the package directory so the
 * TypeScript project service resolves that package's tsconfig.json.
 *
 * @param {{ tsconfigRootDir: string, react?: boolean, next?: boolean }} options
 *   `react`: browser globals + React hooks rules (UI packages, Next apps).
 *   `next`: Next.js core-web-vitals rules on top of `react`.
 */
export function createEslintConfig({ tsconfigRootDir, react = false, next = false }) {
  const browser = react || next;
  return defineConfig(
    {
      ignores: [
        '**/dist/**',
        '**/.next/**',
        '**/coverage/**',
        '**/.turbo/**',
        '**/generated/**',
        '**/next-env.d.ts',
      ],
    },
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        globals: browser ? { ...globals.browser, ...globals.node } : { ...globals.node },
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
    browser
      ? [
          reactHooks.configs.flat.recommended,
          {
            rules: {
              // Event handlers returning promises are fine in JSX (`onClick={async () => …}`).
              '@typescript-eslint/no-misused-promises': [
                'error',
                { checksVoidReturn: { attributes: false } },
              ],
              // Never render user content as HTML (master prompt, Global Rules).
              'no-restricted-syntax': [
                'error',
                {
                  selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
                  message: 'Never render HTML. User content is text only.',
                },
              ],
            },
          },
        ]
      : [],
    next ? [nextPlugin.configs['core-web-vitals']] : [],
    {
      // Plain JS config files are not part of any tsconfig project.
      files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
      extends: [tseslint.configs.disableTypeChecked],
    },
    {
      files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts'],
      rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
    },
    prettier,
  );
}
