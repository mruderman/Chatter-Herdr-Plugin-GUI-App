import { describe, expect, it } from 'vitest';
import { NAMED_COLOURS, parseCss, readStyle } from './css-test-utils';

// Rules of the stylesheets that no browser run would notice going wrong: colours only from tokens,
// every variable defined, nothing remote, motion switched off in one place.

const TOKENS = readStyle('./tokens.css');
const OTHERS = {
  'base.css': readStyle('./base.css'),
  'layout.css': readStyle('./layout.css'),
  'components.css': readStyle('./components.css'),
} as const;
const INDEX = readStyle('./index.css');
const ALL = { 'tokens.css': TOKENS, ...OTHERS, 'index.css': INDEX };

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every declaration value in a stylesheet, as written. */
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

describe('colours come from tokens only', () => {
  it.each(Object.entries(OTHERS))('%s has no hex, functional or named colour', (_name, css) => {
    const values = declarationValues(css);
    // Without this a broken reader would find nothing and the test would pass for the wrong reason.
    expect(values.length).toBeGreaterThan(10);
    const found: string[] = [];
    for (const value of values) {
      if (/#[0-9a-f]{3,8}\b/i.test(value)) found.push(value);
      if (/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i.test(value)) found.push(value);
      for (const word of value.toLowerCase().split(/[^a-z-]+/)) {
        if ((NAMED_COLOURS as readonly string[]).includes(word)) found.push(value);
      }
    }
    expect(found).toEqual([]);
  });

  it('sees a colour literal when one is there', () => {
    const sample = '.x { color: #fff; background: rgb(0 0 0); border-color: red; outline-color: var(--color-focus); }';
    const values = declarationValues(sample);
    expect(values).toEqual(['#fff', 'rgb(0 0 0)', 'red', 'var(--color-focus)']);
    expect(NAMED_COLOURS).toContain('red');
  });

  it('does not fade text or controls with opacity, which would break the contrast the tokens guarantee', () => {
    for (const [name, css] of Object.entries(OTHERS)) {
      // opacity: 1 is allowed: it undoes the browser's own fade on placeholders.
      expect(withoutComments(css), name).not.toMatch(/\bopacity\s*:(?!\s*1\s*[;}])/);
    }
  });

  it('gives placeholders a token colour at full opacity', () => {
    const rule = parseCss(OTHERS['base.css']).find((candidate) => candidate.selector === '::placeholder');
    expect(rule?.declarations.get('color')).toBe('var(--color-text-muted)');
    expect(rule?.declarations.get('opacity')).toBe('1');
  });
});

describe('variables', () => {
  const declared = new Set<string>();
  for (const css of Object.values(ALL)) {
    for (const match of withoutComments(css).matchAll(/(--[a-z0-9-]+)\s*:/gi)) if (match[1]) declared.add(match[1]);
  }

  it.each(Object.entries(ALL))('%s uses only custom properties that some stylesheet defines', (_name, css) => {
    const used = [...withoutComments(css).matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((match) => match[1] ?? '');
    expect(used.filter((name) => !declared.has(name))).toEqual([]);
  });
});

describe('nothing remote, nothing inline', () => {
  it.each(Object.entries(ALL))('%s has no URL, font file or image', (_name, css) => {
    const source = withoutComments(css);
    expect(source).not.toMatch(/https?:|\/\/|url\(|@font-face|image-set|@import\s+url/i);
  });

  it('imports only its own four files, tokens first', () => {
    const imports = [...withoutComments(INDEX).matchAll(/@import\s+'([^']+)'\s*;/g)].map((match) => match[1]);
    expect(imports).toEqual(['./tokens.css', './base.css', './layout.css', './components.css']);
  });
});

describe('motion and focus', () => {
  const baseRules = parseCss(OTHERS['base.css']);

  it('removes every transition and animation in one reduced-motion block', () => {
    const block = baseRules.find((rule) => rule.atRules.some((atRule) => atRule.includes('prefers-reduced-motion: reduce')));
    expect(block?.selector).toBe('*, *::before, *::after');
    expect(block?.declarations.get('animation')).toBe('none !important');
    expect(block?.declarations.get('transition')).toBe('none !important');
    expect(block?.declarations.get('scroll-behavior')).toBe('auto !important');
  });

  it('uses !important nowhere else', () => {
    const outsideTheBlock = Object.values(OTHERS)
      .map((css) => withoutComments(css).replace(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}\n/, ''))
      .join('\n');
    expect(outsideTheBlock).not.toContain('!important');
  });

  it('draws the focus ring as a 3px-or-wider outline from the tokens, not as a shadow', () => {
    const ring = baseRules.find((rule) => rule.selector === ':focus-visible' && rule.atRules.length === 0);
    expect(ring?.declarations.get('outline')).toBe('var(--focus-width) solid var(--color-focus)');
    expect(ring?.declarations.get('outline-offset')).toBe('var(--focus-offset)');
  });

  it('never removes the ring from a control with outline: none', () => {
    const offenders: string[] = [];
    for (const [name, css] of Object.entries(OTHERS)) {
      for (const rule of parseCss(withoutComments(css))) {
        if (/^(none|0)$/.test(rule.declarations.get('outline') ?? '')) offenders.push(`${name}: ${rule.selector}`);
      }
    }
    // Only the page's root marker, which is a position and not a control, may go without a ring.
    expect(offenders).toEqual(['layout.css: .app:focus, .app:focus-visible']);
  });

  it('pins nothing to the viewport, so a focused control cannot be hidden behind it', () => {
    for (const [name, css] of Object.entries(OTHERS)) {
      const positions = declarationValues(css).filter((value) => /^(fixed|sticky)$/.test(value));
      expect(positions, name).toEqual([]);
    }
  });
});

describe('forced colours', () => {
  const componentRules = parseCss(OTHERS['components.css']);
  const forced = componentRules.filter((rule) => rule.atRules.some((atRule) => atRule.includes('forced-colors: active')));

  it('marks the current navigation item with an underline, because its tint and bar are flattened', () => {
    const current = forced.find((rule) => rule.selector === ".nav-button[aria-current='page']");
    expect(current?.declarations.get('text-decoration')).toBe('underline');
  });

  it('draws the connection marker in system colours', () => {
    const marker = forced.find((rule) => rule.selector === '.connection::before');
    expect(marker?.declarations.get('forced-color-adjust')).toBe('none');
    expect(forced.some((rule) => rule.selector.includes('.connection--online::before'))).toBe(true);
  });

  it('states the system colour of links and hints so audit tools read what the browser will show', () => {
    expect(forced.find((rule) => rule.selector === 'a')?.declarations.get('color')).toBe('LinkText');
    expect(forced.find((rule) => rule.selector === '.field__hint')?.declarations.get('color')).toBe('CanvasText');
  });
});
