// Metro handles .css side-effect imports (web fonts in global.css); this only
// tells tsc they exist. `expo start` generates expo-env.d.ts with the same
// declaration, but the monorepo typecheck must pass on a fresh clone too.
declare module '*.css';
