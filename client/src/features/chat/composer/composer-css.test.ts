// The composer's stylesheet keeps the shell's rules (styles/styles.test.ts checks the shell's own files,
// not this one): colours only from tokens, nothing remote or pinned, no faded text, no state shown by
// colour alone, and targets at least the contract's 24 px.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAMED_COLOURS, parseCss, readStyle } from '../../../styles/css-test-utils';

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
// A path, not new URL('./composer.css', import.meta.url), which Vite would turn into a served asset URL.
const CSS = withoutComments(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'composer.css'), 'utf8'));
const SHELL = ['./tokens.css', './base.css', './layout.css', './components.css'].map((name) => withoutComments(readStyle(name)));
const RULES = parseCss(CSS);

const values = RULES.flatMap((rule) => [...rule.declarations.values()]);
const ruleFor = (selector: string, atRule?: string) =>
  RULES.find((rule) => rule.selector === selector && (atRule === undefined ? rule.atRules.length === 0 : rule.atRules.some((at) => at.includes(atRule))));

describe('composer.css', () => {
  it('takes every colour from a token: no hex, functional or named colour', () => {
    // Without this a broken reader would find nothing and pass for the wrong reason.
    expect(values.length).toBeGreaterThan(20);
    const found = values.filter(
      (value) =>
        /#[0-9a-f]{3,8}\b/i.test(value) ||
        /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i.test(value) ||
        value
          .toLowerCase()
          .split(/[^a-z-]+/)
          .some((word) => (NAMED_COLOURS as readonly string[]).includes(word)),
    );
    expect(found).toEqual([]);
  });

  it('uses only custom properties the shell\'s stylesheets declare', () => {
    const declared = new Set(SHELL.flatMap((css) => [...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1])));
    const used = [...CSS.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((match) => match[1] ?? '');
    expect(used.length).toBeGreaterThan(10);
    expect(used.filter((name) => !declared.has(name))).toEqual([]);
  });

  it('loads nothing remote and pins nothing to the viewport', () => {
    expect(CSS).not.toMatch(/https?:|\/\/|url\(|@import|@font-face|image-set/i);
    expect(values.filter((value) => /^(fixed|sticky)$/.test(value))).toEqual([]);
  });

  it('keeps the shell\'s focus ring, motion and contrast rules: no outline removed, no !important, no transition, no fading', () => {
    expect(RULES.filter((rule) => /^(none|0)$/.test(rule.declarations.get('outline') ?? ''))).toEqual([]);
    expect(CSS).not.toMatch(/!important|transition|animation|opacity/);
  });

  it('marks the active suggestion with a bar and bold text, not only a tint', () => {
    expect(ruleFor('.mention-option')?.declarations.get('border-inline-start')).toMatch(/^4px solid/);
    const active = ruleFor(".mention-option[aria-selected='true']");
    expect(active?.declarations.get('font-weight')).toBe('700');
    expect(active?.declarations.get('border-inline-start-color')).toBe('var(--color-accent)');
  });

  it('gives the active suggestion the system highlight under forced colours, where tints are flattened', () => {
    const forced = ruleFor(".mention-option[aria-selected='true']", 'forced-colors: active');
    expect(forced?.declarations.get('forced-color-adjust')).toBe('none');
    expect(forced?.declarations.get('background')).toBe('Highlight');
    expect(forced?.declarations.get('color')).toBe('HighlightText');
  });

  it('makes each suggestion a target of at least 24 by 24 CSS px', () => {
    expect(ruleFor('.mention-option')?.declarations.get('min-block-size')).toBe('var(--target-min)');
  });

  it('lets the send notice wrap its button under the text and shrink its text, so a long warning cannot widen the page', () => {
    const notice = ruleFor('.composer .composer__notice');
    expect(notice?.declarations.get('display')).toBe('flex');
    expect(notice?.declarations.get('flex-wrap')).toBe('wrap');
    expect(notice?.declarations.get('margin')).toBe('0');
    // So that scrolling it into view leaves room under it instead of putting its border on the window's edge.
    expect(notice?.declarations.get('scroll-margin-block-end')).toBe('var(--space-5)');
    expect(ruleFor('.composer__notice-text')?.declarations.get('min-inline-size')).toBe('0');
  });

  it('sets the send notice\'s lead in bold, so the words and not only the tint say what it is', () => {
    expect(ruleFor('.composer__notice-lead')?.declarations.get('font-weight')).toBe('700');
  });

  it('marks the read-only notice with a dashed border as well as its words', () => {
    expect(ruleFor('.composer__read-only')?.declarations.get('border')).toMatch(/dashed/);
  });

  // T21: the composer was 287 px tall at 1280 x 720 because "To" and Send had a row each. From 48rem up (where the
  // conversation list also moves beside the feed) the form's own grid holds the three on one row, with the hint and
  // the count under it; below that it is the single column it was.
  describe('the one row from 48rem up (T21)', () => {
    const WIDE = 'min-width: 48rem';
    const BOTH_FIELDS = '.composer .composer__to, .composer .composer__message';
    const inRow = (selector: string) => ruleFor(selector, WIDE);

    it('is three columns (To, the message box, Send) from 48rem up, and the single column it was below', () => {
      expect(ruleFor('.composer')?.declarations.get('grid-template-columns')).toBe('minmax(0, 1fr)');
      const row = inRow('.composer');
      // The first column is bounded by the composer's own width too, so that 200% text, which scales every rem, cannot take
      // all of it from the message box; Send takes what it needs.
      expect(row?.declarations.get('grid-template-columns')).toBe('minmax(6rem, min(10rem, 28%)) minmax(0, 1fr) auto');
      // No row gap: a row with nothing in it (the suggestions, the count) would still take its gap. The items have margins.
      expect(row?.declarations.get('gap')).toBe('0 var(--space-3)');
    });

    it('hands the two fields\' children to the form\'s grid from 48rem up only, so that the markup, and with it the tab order, is the same in both layouts', () => {
      expect(ruleFor(BOTH_FIELDS)).toBeUndefined();
      expect(inRow(BOTH_FIELDS)?.declarations.get('display')).toBe('contents');
    });

    it('puts each piece in its own cell: the labels over their controls, Send at the end of the message box\'s row, the rest under the row', () => {
      const cells: ReadonlyArray<readonly [string, string, string]> = [
        ['.composer__to-label', '1', '1'],
        ['.composer__message-label', '1', '2'],
        ['.composer__to-select', '2', '1'],
        ['.composer__input', '2', '2'],
        ['.composer__actions', '2', '3'],
        ['.composer .mention-list', '3', '2'],
        ['.composer .composer__hint', '4', '1 / -1'],
        ['.composer .composer__count', '5', '1 / -1'],
        ['.composer .composer__alert', '6', '1 / -1'],
        ['.composer .composer__notice', '7', '1 / -1'],
      ];
      for (const [selector, row, column] of cells) {
        const rule = inRow(selector);
        expect([selector, rule?.declarations.get('grid-row'), rule?.declarations.get('grid-column')]).toEqual([selector, row, column]);
      }
    });

    it('lines Send up with the bottom of the message box and "To" with its top, and lets the select fill its column', () => {
      expect(inRow('.composer__actions')?.declarations.get('align-self')).toBe('end');
      expect(inRow('.composer__to-select')?.declarations.get('align-self')).toBe('start');
      expect(inRow('.composer__to-select')?.declarations.get('inline-size')).toBe('100%');
    });

    it('keeps the labels close over their controls and the rest apart, with margins, because the grid has no gap between rows', () => {
      for (const selector of ['.composer__to-label', '.composer__message-label']) expect(inRow(selector)?.declarations.get('margin-block-end')).toBe('var(--space-1)');
      for (const selector of ['.composer .composer__hint', '.composer .composer__count', '.composer .composer__alert', '.composer .composer__notice']) {
        expect(inRow(selector)?.declarations.get('margin-block-start')).toMatch(/^var\(--space-[1-3]\)$/);
      }
    });

    it('sets no height of its own, only floors and ceilings: so that 200% text and more lines only make it taller', () => {
      const keys = RULES.flatMap((rule) => [...rule.declarations.keys()]);
      expect(keys.length).toBeGreaterThan(20);
      expect(keys.filter((key) => /^(height|block-size)$/.test(key))).toEqual([]);
    });
  });

  // The alert sits under Send like the notice, so it gets what the notice gets: the room that composer.tsx's reveal
  // leaves under it, and no margin of its own (the grid's spacing and the composer's padding are the space around it).
  it('gives the "Send error" alert the notice\'s room under it when the page scrolls to it, and no margin of its own', () => {
    const alert = ruleFor('.composer .composer__alert');
    expect(alert?.declarations.get('margin')).toBe('0');
    expect(alert?.declarations.get('scroll-margin-block-end')).toBe('var(--space-5)');
    expect(alert?.declarations.get('scroll-margin-block-end')).toBe(ruleFor('.composer .composer__notice')?.declarations.get('scroll-margin-block-end'));
  });
});
