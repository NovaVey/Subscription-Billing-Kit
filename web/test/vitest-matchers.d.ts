// jest-dom's own `@testing-library/jest-dom/vitest` self-augmentation
// resolves its `declare module 'vitest'` target relative to WHERE THE
// PACKAGE ITSELF is installed (hoisted to the repo root's node_modules in
// this workspace layout), which can be a different physical `vitest`
// install than the one this workspace's own test files resolve `import ...
// from 'vitest'` against - TypeScript's declaration merging is keyed by
// physical file identity, so the two don't merge and `toBeInTheDocument()`
// etc. type as missing even though the runtime matcher registration (in
// test/setup.ts) works correctly. Authoring the augmentation here, from
// inside web/ itself, resolves 'vitest' against THIS workspace's own copy,
// matching what test files actually import.
import 'vitest';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging, not an empty type
  interface Assertion<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging, not an empty type
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
}
