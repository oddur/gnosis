import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      // Sparkles is banned in every variant (lib/banned-icons.mjs); AI actions use Bot.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'lucide-react',
              importNames: ['Sparkles', 'SparklesIcon', 'LucideSparkles', 'Sparkle', 'SparkleIcon', 'WandSparkles', 'WandSparklesIcon'],
              message: 'Sparkles icons are banned in Gnosis. Use Bot for AI actions.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    ignores: ['.vite/**', 'out/**', 'build/**', 'dist/**', 'dist-extension/**'],
  }
);
