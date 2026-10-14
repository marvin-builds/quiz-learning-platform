import { createHmac } from 'node:crypto';

// TOTP (RFC 6238) with the parameters GoTrue uses: HMAC-SHA1, 30-second
// steps, 6 digits, a base32 secret. For the e2e tests' admin sign-in (#122);
// tests/e2e/totp.test.ts checks it against the RFC's test vectors.

const STEP_SECONDS = 30;

function base32Decode(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secret.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error(`Not a base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The TOTP code (RFC 6238) of a base32 secret at a time in milliseconds. */
export function totp(secret: string, at: number = Date.now(), digits = 6): string {
  const counter = Math.floor(at / 1000 / STEP_SECONDS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Milliseconds until the next 30-second step begins. */
export function untilNextStep(at: number = Date.now()): number {
  return STEP_SECONDS * 1000 - (at % (STEP_SECONDS * 1000));
}
