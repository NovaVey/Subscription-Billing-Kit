import { describe, expect, it } from 'vitest';
import { resolveAdminRole } from '../../src/lib/adminAuth.js';

const keys = { writeKey: 'the-write-key', readonlyKey: 'the-readonly-key' };

describe('resolveAdminRole', () => {
  it('resolves the write key to the write role', () => {
    expect(resolveAdminRole('Bearer the-write-key', keys)).toBe('write');
  });

  it('resolves the readonly key to the read role', () => {
    expect(resolveAdminRole('Bearer the-readonly-key', keys)).toBe('read');
  });

  it('rejects a key that matches neither', () => {
    expect(resolveAdminRole('Bearer not-a-real-key', keys)).toBeNull();
  });

  it('rejects a missing Authorization header', () => {
    expect(resolveAdminRole(undefined, keys)).toBeNull();
  });

  it('rejects a header without the Bearer scheme', () => {
    expect(resolveAdminRole('the-write-key', keys)).toBeNull();
  });

  it('rejects an empty Bearer token', () => {
    expect(resolveAdminRole('Bearer ', keys)).toBeNull();
  });

  it('is case-sensitive on the key itself', () => {
    expect(resolveAdminRole('Bearer THE-WRITE-KEY', keys)).toBeNull();
  });

  it('does not resolve a key that is a prefix or superstring of the real one', () => {
    expect(resolveAdminRole('Bearer the-write-ke', keys)).toBeNull();
    expect(resolveAdminRole('Bearer the-write-key-extra', keys)).toBeNull();
  });

  it('accepts the Bearer scheme case-insensitively, per RFC 7235', () => {
    expect(resolveAdminRole('bearer the-write-key', keys)).toBe('write');
    expect(resolveAdminRole('BEARER the-write-key', keys)).toBe('write');
  });
});
