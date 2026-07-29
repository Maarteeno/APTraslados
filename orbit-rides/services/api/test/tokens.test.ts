import { describe, it, expect } from 'vitest';
import { issueDevToken, verifyDevToken, extractBearer } from '../src/auth/tokens.js';
import { UnauthorizedError } from '../src/lib/errors.js';

describe('tokens de desarrollo', () => {
  it('firma y verifica', () => {
    const token = issueDevToken('user-1');
    expect(verifyDevToken(token).sub).toBe('user-1');
  });

  it('rechaza un token con el payload alterado', () => {
    const token = issueDevToken('user-1');
    const [, signature] = token.split('.') as [string, string];
    const fakeBody = Buffer.from(JSON.stringify({
      sub: 'admin', iat: 0, exp: Math.floor(Date.now() / 1000) + 999,
    })).toString('base64url');
    expect(() => verifyDevToken(`${fakeBody}.${signature}`)).toThrow(UnauthorizedError);
  });

  it('rechaza un token vencido', () => {
    const past = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const token = issueDevToken('user-1', past);
    expect(() => verifyDevToken(token)).toThrow(/vencido/);
  });

  it('rechaza formatos raros sin explotar', () => {
    for (const bad of ['', 'a', 'a.b.c', '...', 'no-un-token']) {
      expect(() => verifyDevToken(bad)).toThrow(UnauthorizedError);
    }
  });

  it('extrae el bearer y rechaza lo que no lo sea', () => {
    expect(extractBearer('Bearer abc123')).toBe('abc123');
    expect(extractBearer('bearer abc123')).toBe('abc123');
    expect(() => extractBearer(undefined)).toThrow(UnauthorizedError);
    expect(() => extractBearer('Basic abc')).toThrow(UnauthorizedError);
  });
});
