import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'legacy/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'tests/**/*.ts'],
    rules: {
      // The engine allocates scratch vectors and mutates them in the hot path
      // on purpose; underscore-prefixed names mark that intent (_wp, _up).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    // ── The boundary the whole architecture rests on ──────────────────────
    // src/engine is a vanilla, imperative, headlessly-testable simulation.
    // The moment React leaks into it, the physics stops being runnable in
    // Node and the per-frame hot path starts paying reconciliation costs.
    // Engine talks to the UI in exactly two ways: it mutates the telemetry
    // object, and it reads/writes the zustand store imperatively.
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-*', 'react/*', '@ui', '@ui/*', '**/ui/**'],
              message:
                'src/engine must stay React-free and headlessly testable. ' +
                'Push state out through engine/telemetry.ts (per-frame values) ' +
                'or the store (discrete state) instead of importing UI code.',
            },
          ],
        },
      ],
    },
  },

  {
    // Mirror of the rule above: the UI never reaches for the renderer, the
    // physics world, or the scene graph. It reads telemetry and store state.
    files: ['src/ui/**/*.ts', 'src/ui/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['three', 'three/*', 'cannon', 'cannon-es'],
              message:
                'React components must not touch Three.js or the physics engine. ' +
                'The canvas belongs to src/engine; go through telemetry or the store.',
            },
          ],
        },
      ],
    },
  },
);
