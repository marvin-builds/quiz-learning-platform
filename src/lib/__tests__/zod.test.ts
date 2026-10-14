import { z } from '@/lib/zod';

describe('the app zod module', () => {
  it('runs zod jitless, so no parse probes `new Function` under the CSP', () => {
    expect(z.config().jitless).toBe(true);
  });
});
