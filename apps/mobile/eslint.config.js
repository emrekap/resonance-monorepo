import config from '@repo/eslint-config/react-native';

/**
 * The design system's enforcement layer. Colour and radius are decided in
 * `src/design/tokens.ts` and applied by `src/components/ui/*` — everywhere
 * else, a literal is drift. This rule is what caught `#3c87f7` sitting in
 * `themed-text.tsx` ignoring the theme, and five copies of `borderRadius: 14`.
 */
export default [
  ...config,
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/design/**', 'src/components/ui/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message:
            'Colour literals belong in src/design/tokens.ts. Use a theme token via useTheme() or a ui/ primitive.',
        },
        {
          selector: 'Property[key.name="borderRadius"] > Literal',
          message:
            'Radius literals belong in src/design/tokens.ts. Use theme.radius.* or a ui/ primitive.',
        },
      ],
    },
  },
];
