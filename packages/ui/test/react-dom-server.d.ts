/**
 * Minimal ambient typing for react-dom/server.
 *
 * packages/ui intentionally has no @types/react-dom dependency (the workspace
 * forbids adding package.json deps) and the SSR tests only need renderToString.
 * Runtime behavior is unaffected: vitest loads the real react-dom/server JS.
 */
declare module 'react-dom/server' {
  import type { ReactNode } from 'react';

  export function renderToString(node: ReactNode): string;
  export function renderToStaticMarkup(node: ReactNode): string;
}
