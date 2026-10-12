// The Board stylesheet follows the rules styles/styles.test.ts holds the shared ones to, which that
// test does not read this file for: colours only from tokens, nothing remote, nothing that fades text
// or removes the focus ring, and every class the markup uses has a rule.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAMED_COLOURS, parseCss, readStyle } from '../../styles/css-test-utils';

const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

const CSS = read('./board.css');
const RULES = parseCss(CSS);
const VALUES = RULES.flatMap((rule) => [...rule.declarations.values()]);

describe('board.css', () => {
  it('has rules to check (a broken reader would find none and pass for the wrong reason)', () => {
    expect(RULES.length).toBeGreaterThan(10);
    expect(VALUES.length).toBeGreaterThan(20);
  });

  it('takes every colour from the tokens: no hex, functional or named colour', () => {
    const found: string[] = [];
    for (const value of VALUES) {
      if (/#[0-9a-f]{3,8}\b/i.test(value)) found.push(value);
      if (/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i.test(value)) found.push(value);
      for (const word of value.toLowerCase().split(/[^a-z-]+/)) {
        if ((NAMED_COLOURS as readonly string[]).includes(word)) found.push(value);
      }
    }
    expect(found).toEqual([]);
  });

  it('uses only custom properties that the shared stylesheets define', () => {
    const declared = new Set<string>();
    for (const sheet of ['./tokens.css', './base.css', './layout.css', './components.css']) {
      for (const match of withoutComments(readStyle(sheet)).matchAll(/(--[a-z0-9-]+)\s*:/gi)) if (match[1]) declared.add(match[1]);
    }
    const used = [...withoutComments(CSS).matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((match) => match[1] ?? '');
    expect(used.length).toBeGreaterThan(5);
    expect(used.filter((name) => !declared.has(name))).toEqual([]);
  });

  it('has nothing remote, no font, no image and no import', () => {
    expect(withoutComments(CSS)).not.toMatch(/https?:|\/\/|url\(|@font-face|image-set|@import/i);
  });

  it('does not fade text, drop the focus ring, or pin anything to the viewport', () => {
    expect(withoutComments(CSS)).not.toContain('!important');
    expect(withoutComments(CSS)).not.toMatch(/\bopacity\s*:/);
    for (const rule of RULES) {
      expect(rule.declarations.get('outline') ?? '', rule.selector).not.toMatch(/^(none|0)$/);
      expect(rule.declarations.get('position') ?? '', rule.selector).not.toMatch(/^(fixed|sticky)$/);
    }
  });

  // Seen in real Chromium with one 120-letter word in two columns: with `overflow-wrap: anywhere` the
  // table's automatic layout squeezed the short columns to a few letters ("Ha rn es s", "TAS K-1").
  // A cap on a cell's width plus `break-word` keeps ordinary words whole and wraps only the long one.
  it('caps a table cell\'s width and keeps its words whole, so one long word cannot squeeze the other columns', () => {
    const cells = RULES.find((rule) => rule.selector === '.board__table th, .board__table td');
    expect(cells?.declarations.get('max-inline-size')).toMatch(/^\d+(\.\d+)?rem$/);
    expect(cells?.declarations.get('overflow-wrap')).toBe('break-word');
  });

  it('keeps a date and a task id in one piece', () => {
    const pieces = RULES.find((rule) => rule.selector === '.board time, .board__id');
    expect(pieces?.declarations.get('white-space')).toBe('nowrap');
  });

  it('lets a long word in a note wrap, and keeps its line breaks', () => {
    const text = RULES.find((rule) => rule.selector === '.board-item__text');
    expect(text?.declarations.get('white-space')).toBe('pre-wrap');
    expect(text?.declarations.get('overflow-wrap')).toBe('anywhere');
  });

  // Seen in real Chromium with forced colours emulated: axe compared the muted grey that the stylesheet
  // wrote with the forced background and reported serious contrast failures, until the text named its
  // system colour (as the shell does for .field__hint).
  it('names the system colour of every muted text in forced-colours mode', () => {
    const selectorsOf = (rules: typeof RULES): string[] => rules.flatMap((rule) => rule.selector.split(',').map((selector) => selector.trim()));
    const forced = RULES.filter((rule) => rule.atRules.some((atRule) => atRule.includes('forced-colors: active')));
    const muted = selectorsOf(RULES.filter((rule) => rule.declarations.get('color') === 'var(--color-text-muted)' && rule.atRules.length === 0));
    expect(muted.length).toBeGreaterThan(0);
    for (const selector of muted) expect(selectorsOf(forced), selector).toContain(selector);
    for (const rule of forced) expect(rule.declarations.get('color'), rule.selector).toBe('CanvasText');
  });

  it('keeps a wide table inside its own scroll region instead of squeezing it or widening the page', () => {
    const table = RULES.find((rule) => rule.selector === '.board__table');
    expect(table?.declarations.get('min-inline-size')).toBeTruthy();
  });

  it('has a rule for every board class the markup uses', () => {
    const selectors = RULES.map((rule) => rule.selector).join(' ');
    const used = new Set<string>();
    for (const file of ['./BoardView.tsx', './board-sections.tsx']) {
      for (const match of read(file).matchAll(/class="([^"]+)"/g)) {
        for (const name of (match[1] ?? '').split(/\s+/)) if (name.startsWith('board')) used.add(name);
      }
    }
    expect(used.size).toBeGreaterThan(8);
    expect([...used].filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(selectors))).toEqual([]);
  });
});
