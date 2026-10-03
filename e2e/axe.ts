import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

const BLOCKING_IMPACTS = ['serious', 'critical'];

// Fails on serious and critical accessibility violations, naming each rule.
export async function expectNoSeriousAxeViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => BLOCKING_IMPACTS.includes(v.impact ?? ''));
  if (blocking.length > 0) {
    const summary = blocking
      .map((v) => `${v.id} (${v.impact}): ${v.help}, ${v.nodes.length} element(s)`)
      .join('\n');
    throw new Error(`Serious or critical axe violations:\n${summary}`);
  }
}
