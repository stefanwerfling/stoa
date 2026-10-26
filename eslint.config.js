import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        // Fixtures are deliberately imperfect analysis subjects, not engine code.
        ignores: ['dist/', 'node_modules/', 'coverage/', 'test/fixtures/']
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-console': ['warn', {allow: ['warn', 'error']}],
            eqeqeq: 'error',
            'prefer-const': 'error',
            'no-var': 'error',
            '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}]
        }
    }
);
