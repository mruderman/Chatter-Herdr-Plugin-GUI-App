// The design system's stylesheet rules (styles.test.ts) cover only its own four files, and a feature's
// stylesheet is imported by its component, so this holds admin.css to the same rules: colours only
// from tokens, every variable defined, nothing remote or fixed, no way to lose the focus ring, and the
// two colours it adds are the ones whose contrast the tokens test asserts.
import { describe, expect, it } from 'vitest';
import { NAMED_COLOURS, parseCss, readStyle } from '../../styles/css-test-utils';

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
// readStyle resolves from the styles folder; a literal `new URL('./admin.css', import.meta.url)` here would
// be taken by Vite for an asset import and rewritten.
const ADMIN = readStyle('../features/admin/admin.css');
const SYSTEM = ['tokens.css', 'base.css', 'layout.css', 'components.css'].map((name) => readStyle(`../styles/${name}`)).join('\n');

function declarationValues(css: string): string[] {
  const values: string[] = [];
  for (const body of withoutComments(css).matchAll(/\{([^{}]*)\}/g)) {
    for (const part of (body[1] ?? '').split(';')) {
      const colon = part.indexOf(':');
      if (colon !== -1) values.push(part.slice(colon + 1).trim());
    }
  }
  return values;
}

describe('admin.css follows the design system', () => {
  it('has declarations to check, so the rules below are not passing on an empty read', () => {
    expect(declarationValues(ADMIN).length).toBeGreaterThan(10);
  });

  it('takes every colour from a token: no hex, functional or named colour', () => {
    const found: string[] = [];
    for (const value of declarationValues(ADMIN)) {
      if (/#[0-9a-f]{3,8}\b/i.test(value)) found.push(value);
      if (/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i.test(value)) found.push(value);
      for (const word of value.toLowerCase().split(/[^a-z-]+/)) {
        if ((NAMED_COLOURS as readonly string[]).includes(word)) found.push(value);
      }
    }
    expect(found).toEqual([]);
  });

  it('uses only custom properties that the design system defines', () => {
    const declared = new Set([...withoutComments(SYSTEM).matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
    const used = [...withoutComments(ADMIN).matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((match) => match[1] ?? '');
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !declared.has(name))).toEqual([]);
  });

  it('has no URL, font, image or import, so nothing remote can load', () => {
    expect(withoutComments(ADMIN)).not.toMatch(/https?:|\/\/|url\(|@font-face|image-set|@import/i);
  });

  it('never fades text with opacity, forces nothing with !important and pins nothing to the viewport', () => {
    const css = withoutComments(ADMIN);
    expect(css).not.toMatch(/\bopacity\s*:/);
    expect(css).not.toContain('!important');
    expect(declarationValues(ADMIN).filter((value) => /^(fixed|sticky)$/.test(value))).toEqual([]);
  });

  it('never removes the focus ring', () => {
    const offenders = parseCss(ADMIN)
      .filter((rule) => /^(none|0)$/.test(rule.declarations.get('outline') ?? ''))
      .map((rule) => rule.selector);
    expect(offenders).toEqual([]);
  });

  it('marks an invalid field by shape as well as colour: a heavier border, at least 3px', () => {
    const rule = parseCss(ADMIN).find((candidate) => candidate.selector === ".admin input[aria-invalid='true']");
    expect(rule?.declarations.get('border-color')).toBe('var(--color-danger-solid)');
    expect(Number.parseFloat(rule?.declarations.get('border-width') ?? '0')).toBeGreaterThanOrEqual(3);
  });

  it('wraps the token at any width instead of letting it scroll sideways or run off the dialog', () => {
    const rule = parseCss(ADMIN).find((candidate) => candidate.selector === '.token-field');
    expect(rule?.declarations.get('inline-size')).toBe('100%');
    expect(rule?.declarations.get('overflow-wrap')).toBe('anywhere');
  });

  it('keeps the row buttons in one line, so that a narrow screen scrolls the table instead of stacking them', () => {
    const rule = parseCss(ADMIN).find((candidate) => candidate.selector === '.admin-table .cluster');
    expect(rule?.declarations.get('flex-wrap')).toBe('nowrap');
  });

  it('lets a long audit detail wrap instead of widening the page, but never down to a sliver', () => {
    const rule = parseCss(ADMIN).find((candidate) => candidate.selector === '.admin-detail');
    expect(rule?.declarations.get('overflow-wrap')).toBe('anywhere');
    expect(Number.parseFloat(rule?.declarations.get('min-inline-size') ?? '0')).toBeGreaterThanOrEqual(8);
  });
});

// The contrast of the two colours admin.css adds (the field error's text on the page and on a dialog, the
// invalid field's border on a dialog) is asserted for every theme by styles/tokens.test.ts, which pairs every
// tone text and the danger colour with every surface. What is left to check here is that the stylesheet
// really uses those colours (the border is checked above), since another token would escape that pairing.
describe('the colour that admin.css gives a field error is the one whose contrast the tokens test asserts', () => {
  it('writes a field error in the danger tone text', () => {
    expect(parseCss(ADMIN).find((candidate) => candidate.selector === '.field__error')?.declarations.get('color')).toBe('var(--tone-danger-text)');
  });
});
