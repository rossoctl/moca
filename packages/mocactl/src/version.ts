// The build's version: a release tag, `edge-<sha>`, or `dev`. build.mjs bakes it in with esbuild's
// `define` (docs/specs/2026-10-08-mocactl-installer-design.md §4). Running from a checkout under tsx,
// nothing defines the constant, so `typeof` (safe on an undeclared global) falls back to `dev`.
declare const MOCACTL_VERSION: string | undefined;

export const VERSION: string = typeof MOCACTL_VERSION === 'string' ? MOCACTL_VERSION : 'dev';
