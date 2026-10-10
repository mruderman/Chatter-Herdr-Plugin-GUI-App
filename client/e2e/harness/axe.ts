import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

// The plan's accessibility gate: WCAG 2.2 AA through these axe tags, failing on serious or critical.
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const FAILING_IMPACTS = new Set(['serious', 'critical']);

export async function axeScan(page: Page) {
  return new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
}

/** Serious and critical findings, one readable line each (rule, impact, help, where). */
export async function seriousViolations(page: Page): Promise<string[]> {
  const { violations } = await axeScan(page);
  return violations
    .filter((v) => FAILING_IMPACTS.has(v.impact ?? ''))
    .map((v) => `${v.id} (${v.impact}): ${v.help} at ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
