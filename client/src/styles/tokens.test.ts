import { describe, expect, it } from 'vitest';
import {
  composite,
  contrastRatio,
  failingPairs,
  parseCss,
  parseHex,
  readStyle,
  type ColourPair,
  type CssRule,
  type PairKind,
} from './css-test-utils';

// WCAG 2.2 AA is what docs/ui-contract.md section 6 asks for: 4.5:1 for text, 3:1 for UI components
// and for the focus ring. The high-contrast theme exists to go beyond the minimum, so it is held to
// 7:1 and 4.5:1 (the AAA text level) as a design choice of this theme, not a contract line.
const CONTRACT_MINIMUM = { text: 4.5, ui: 3 } as const;
const MINIMUM: Readonly<Record<'light' | 'dark' | 'hc', Readonly<Record<PairKind, number>>>> = {
  light: CONTRACT_MINIMUM,
  dark: CONTRACT_MINIMUM,
  hc: { text: 7, ui: 4.5 },
};

type ThemeName = keyof typeof MINIMUM;
const THEMES = Object.keys(MINIMUM) as ThemeName[];

const rules = parseCss(readStyle('./tokens.css'));

function ruleFor(selector: string, atRule?: string): CssRule {
  const found = rules.filter(
    (rule) => rule.selector === selector && (atRule === undefined ? rule.atRules.length === 0 : rule.atRules.join(' ') === atRule),
  );
  if (found.length !== 1 || !found[0]) throw new Error(`expected one rule for "${selector}" ${atRule ?? ''}, found ${found.length}`);
  return found[0];
}

const lightRule = ruleFor(":root, :root[data-theme='light']");
const darkRule = ruleFor(":root[data-theme='dark']");
const hcRule = ruleFor(":root[data-theme='hc']");
// "System" is the absence of data-theme: these two blocks are how it picks dark or high contrast.
const systemDark = ruleFor(':root:not([data-theme])', '@media (prefers-color-scheme: dark)');
const systemHc = ruleFor(':root:not([data-theme])', '@media (prefers-contrast: more), (forced-colors: active)');
const sharedRule = ruleFor(':root');

const themeTokens: Record<ThemeName, ReadonlyMap<string, string>> = {
  light: lightRule.declarations,
  dark: darkRule.declarations,
  hc: hcRule.declarations,
};

const isColourToken = (name: string): boolean => name.startsWith('--color-') || name.startsWith('--tone-');

// Where each colour is used, written out. A colour token no pair mentions fails the completeness test
// below, so adding a token means saying what it is read against.
const BACKGROUNDS = ['--color-bg', '--color-surface', '--color-surface-alt'] as const;
const TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const;
const text = (foreground: string, background: string): ColourPair => ({ kind: 'text', foreground, background });
const ui = (foreground: string, background: string): ColourPair => ({ kind: 'ui', foreground, background });

const PAIRS: readonly ColourPair[] = [
  ...BACKGROUNDS.flatMap((background) => [
    text('--color-text', background),
    text('--color-text-muted', background),
    text('--color-link', background),
    ui('--color-border', background),
    // The ring is drawn with a gap, so it is judged against the surface it sits on.
    ui('--color-focus', background),
  ]),
  text('--color-on-accent', '--color-accent'),
  text('--color-selected-text', '--color-selected-bg'),
  text('--color-on-danger-solid', '--color-danger-solid'),
  ui('--color-accent', '--color-bg'),
  ui('--color-accent', '--color-surface'),
  ui('--color-danger-solid', '--color-bg'),
  ui('--color-danger-solid', '--color-surface'),
  ui('--color-focus', '--color-selected-bg'),
  ...TONES.flatMap((tone) => [
    text(`--tone-${tone}-text`, `--tone-${tone}-bg`),
    text(`--tone-${tone}-text`, '--color-bg'),
    text(`--tone-${tone}-text`, '--color-surface'),
    ui(`--tone-${tone}-border`, '--color-bg'),
    ui(`--tone-${tone}-border`, '--color-surface'),
    ui(`--tone-${tone}-border`, `--tone-${tone}-bg`),
    ui('--color-focus', `--tone-${tone}-bg`),
  ]),
];

// Tokens that are not read against another colour, with the reason. The scrim is translucent: it is
// checked as a composite in the dialog-edge test instead.
const EXEMPT = new Map<string, string>([
  ['--color-scrim', 'translucent overlay behind a modal dialog; its effect is checked as a composite below'],
]);

describe('tokens.css: the three themes are complete and consistent', () => {
  it('declare exactly the same tokens', () => {
    const names = (theme: ThemeName): string[] => [...themeTokens[theme].keys()].sort();
    expect(names('dark')).toEqual(names('light'));
    expect(names('hc')).toEqual(names('light'));
    // A guard against the reader finding nothing, not a count to maintain.
    expect(names('light').filter(isColourToken).length).toBeGreaterThanOrEqual(30);
  });

  it('write every colour as hex, so the contrast maths below reads all of them', () => {
    for (const theme of THEMES) {
      for (const [name, value] of themeTokens[theme]) {
        if (isColourToken(name)) expect(() => parseHex(value), `${theme} ${name}`).not.toThrow();
      }
    }
  });

  it('repeat the dark and hc tokens identically in the @media blocks that "System" (no data-theme) relies on', () => {
    expect([...systemDark.declarations]).toEqual([...darkRule.declarations]);
    expect([...systemHc.declarations]).toEqual([...hcRule.declarations]);
  });

  it('set color-scheme so native controls and scrollbars follow the theme', () => {
    expect(lightRule.declarations.get('color-scheme')).toBe('light');
    expect(darkRule.declarations.get('color-scheme')).toBe('dark');
    expect(hcRule.declarations.get('color-scheme')).toBe('dark');
  });
});

describe('tokens.css: contrast (ui-contract section 6)', () => {
  it.each(THEMES)('%s: every declared foreground and background pair meets its minimum', (theme) => {
    const failures = failingPairs(themeTokens[theme], PAIRS, MINIMUM[theme]).map(
      ({ pair, ratio, minimum }) => `${pair.kind} ${pair.foreground} on ${pair.background}: ${ratio.toFixed(2)} < ${minimum}`,
    );
    expect(failures).toEqual([]);
  });

  it('covers every colour token in some pair, or says why it does not', () => {
    const covered = new Set(PAIRS.flatMap((pair) => [pair.foreground, pair.background]));
    const unaccounted = [...themeTokens.light.keys()].filter((name) => isColourToken(name) && !covered.has(name) && !EXEMPT.has(name));
    expect(unaccounted).toEqual([]);
    for (const name of EXEMPT.keys()) expect(themeTokens.light.has(name), `exempt ${name} must exist`).toBe(true);
  });

  it.each(THEMES)('%s: the dialog stays distinguishable from the scrim behind it', (theme) => {
    const tokens = themeTokens[theme];
    const get = (name: string) => parseHex(tokens.get(name) ?? '');
    // The scrim lies over the page, which is --color-bg or --color-surface.
    for (const page of ['--color-bg', '--color-surface']) {
      const behind = composite(get('--color-scrim'), get(page));
      const byFill = contrastRatio(get('--color-surface'), behind);
      const byBorder = contrastRatio(get('--color-border'), behind);
      // The dialog has a fill and a 2px border; either one setting it apart is enough, and light themes
      // rely on the fill while dark ones rely on the border.
      expect(Math.max(byFill, byBorder), `${theme} over ${page}`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(THEMES)('%s: the scrim is translucent, so the page stays faintly visible behind a dialog', (theme) => {
    const scrim = parseHex(themeTokens[theme].get('--color-scrim') ?? '');
    expect(scrim.a).toBeGreaterThan(0.5);
    expect(scrim.a).toBeLessThan(1);
  });
});

describe('the contrast check itself', () => {
  // A green run only means something if the checker can go red.
  const ratio = (a: string, b: string): number => contrastRatio(parseHex(a), parseHex(b));

  it('computes the published reference ratios', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(ratio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // #767676 on white is the lightest grey that reaches 4.5:1; one step lighter does not.
    expect(ratio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#777777', '#ffffff')).toBeLessThan(4.5);
    expect(ratio('#ffffff', '#767676')).toBe(ratio('#767676', '#ffffff'));
  });

  it('reports a pair below its minimum, and only that pair', () => {
    const tokens = new Map([
      ['--fg-good', '#000000'],
      ['--fg-bad', '#777777'],
      ['--bg', '#ffffff'],
    ]);
    const failures = failingPairs(tokens, [text('--fg-good', '--bg'), text('--fg-bad', '--bg'), ui('--fg-bad', '--bg')], {
      text: 4.5,
      ui: 3,
    });
    expect(failures.map((failure) => [failure.pair.foreground, failure.pair.kind])).toEqual([['--fg-bad', 'text']]);
  });

  it('refuses a pair that names a token the theme does not declare', () => {
    expect(() => failingPairs(new Map([['--a', '#000000']]), [text('--a', '--missing')], CONTRACT_MINIMUM)).toThrow(/--missing/);
  });

  it('composites translucent colours over an opaque one', () => {
    const half = composite(parseHex('#00000080'), parseHex('#ffffff'));
    expect(half.r).toBeGreaterThan(120);
    expect(half.r).toBeLessThan(135);
  });

  it('refuses a colour that is not hex, so no token escapes the maths', () => {
    expect(() => parseHex('rgb(0 0 0)')).toThrow(/not a hex colour/);
    expect(() => parseHex('red')).toThrow(/not a hex colour/);
  });
});

describe('tokens.css: sizes the contract fixes', () => {
  it('keeps the focus ring at least 3px, in pixels', () => {
    const width = sharedRule.declarations.get('--focus-width') ?? '';
    expect(width).toMatch(/^\d+(\.\d+)?px$/);
    expect(Number.parseFloat(width)).toBeGreaterThanOrEqual(3);
  });

  it('keeps targets at least 24 by 24 CSS px whatever the root font size', () => {
    for (const name of ['--target-min', '--checkbox-size']) {
      const value = sharedRule.declarations.get(name) ?? '';
      expect(value, name).toMatch(/^max\(.*,\s*24px\)$/);
    }
  });
});
