// Convenience re-export.
//
// Metro will automatically pick `localstore.native.*` for iOS/Android and
// `localstore.web.*` for web. This file exists so TypeScript tooling can
// resolve `../localstore` consistently.

export * from './localstore.native';
