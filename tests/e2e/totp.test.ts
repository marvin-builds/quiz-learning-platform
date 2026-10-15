import { totp } from '../../e2e/totp';

// The e2e tests compute the seed admin's TOTP codes with e2e/totp.ts (#122).
// A wrong code there would make every admin e2e test fail at the sign-in,
// so it is checked against the test vectors of RFC 6238, appendix B (SHA-1,
// the ASCII secret "12345678901234567890"), here in base32 as GoTrue stores
// secrets. The RFC lists 8 digits; GoTrue uses the last 6.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totp (RFC 6238)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('at %i s gives the RFC code %s', (seconds, code) => {
    expect(totp(RFC_SECRET, seconds * 1000, 8)).toBe(code);
    expect(totp(RFC_SECRET, seconds * 1000)).toBe(code.slice(-6));
  });

  it('keeps a code for the whole 30-second step and changes it with the next', () => {
    expect(totp(RFC_SECRET, 30_000)).toBe(totp(RFC_SECRET, 59_999));
    expect(totp(RFC_SECRET, 59_999)).not.toBe(totp(RFC_SECRET, 60_000));
  });

  it('accepts the secret in lower case and with spaces, as authenticator apps show it', () => {
    expect(totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 59_000)).toBe('287082');
  });
});
