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
});
