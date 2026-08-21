import { describe, expect, it } from 'vitest';
import { resolveListenTarget } from '../../src/lib/listenTarget.js';

describe("resolveListenTarget always binds every interface, regardless of API_BASE_URL's hostname", () => {
  it('binds 0.0.0.0 for the local dev default', () => {
    expect(resolveListenTarget('http://localhost:3000')).toEqual({ port: 3000, host: '0.0.0.0' });
  });

  it('binds 0.0.0.0 even when API_BASE_URL is a real public URL - this used to crash the server on boot (see the deep bug hunt)', () => {
    expect(resolveListenTarget('https://subscription-billing-kit-production-0f5e.up.railway.app')).toEqual({
      port: 3000,
      host: '0.0.0.0',
    });
  });

  it('still extracts an explicit port from API_BASE_URL when one is set, alongside a real public hostname', () => {
    expect(resolveListenTarget('https://billing.example.com:8080')).toEqual({ port: 8080, host: '0.0.0.0' });
  });
});
