// Metro handles .css side-effect imports; this only tells tsc such modules
// exist. `expo start` generates expo-env.d.ts with the same declaration, but
// the monorepo typecheck must pass on a fresh clone too.
declare module '*.css';
