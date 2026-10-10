// Test support for the stylesheets: a small CSS reader and the WCAG contrast maths. Not shipped; only
// the styles tests import it. The reader handles what tokens.css uses (rules, and @media around rules)
// and throws on anything else, so a new construct is noticed rather than silently skipped.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function readStyle(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
}

export interface CssRule {
  /** The enclosing at-rule preludes, outermost first, for example `@media (prefers-color-scheme: dark)`. */
  atRules: string[];
  selector: string;
  declarations: Map<string, string>;
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function parseCss(source: string): CssRule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const open: Array<{ prelude: string; hasChildRules: boolean }> = [];
  // Text since the last brace: before a "{" it is a prelude (selector or at-rule), before a "}" it is
  // the declarations of the rule that is closing.
  let buffer = '';

  for (const char of css) {
    if (char === '{') {
      const parent = open[open.length - 1];
      if (parent) parent.hasChildRules = true;
      open.push({ prelude: squash(buffer), hasChildRules: false });
      buffer = '';
    } else if (char === '}') {
      const block = open.pop();
      if (!block) throw new Error('css-test-utils: unbalanced }');
      if (!block.hasChildRules) {
        const declarations = new Map<string, string>();
        for (const part of buffer.split(';')) {
          const colon = part.indexOf(':');
          if (colon === -1) {
            if (part.trim() !== '') throw new Error(`css-test-utils: cannot read declaration "${squash(part)}"`);
            continue;
          }
          declarations.set(part.slice(0, colon).trim(), squash(part.slice(colon + 1)));
        }
        rules.push({
          atRules: open.map((outer) => outer.prelude).filter((prelude) => prelude.startsWith('@')),
          selector: block.prelude,
          declarations,
        });
      }
      buffer = '';
    } else if (char === ';' && open.length === 0) {
      throw new Error('css-test-utils: statements outside a rule (such as @import) are not supported here');
    } else {
      buffer += char;
    }
  }
  if (open.length > 0) throw new Error('css-test-utils: unbalanced {');
  return rules;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa`; anything else throws, so a token written another way is noticed. */
export function parseHex(value: string): Rgba {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!match || match[1] === undefined) throw new Error(`not a hex colour: "${value}"`);
  let digits = match[1];
  if (digits.length === 3) digits = [...digits].map((digit) => digit + digit).join('');
  const channel = (index: number): number => Number.parseInt(digits.slice(index, index + 2), 16);
  return { r: channel(0), g: channel(2), b: channel(4), a: digits.length === 8 ? channel(6) / 255 : 1 };
}

/** The colour `top` shows when painted over an opaque `under`. */
export function composite(top: Rgba, under: Rgba): Rgba {
  const mix = (over: number, base: number): number => Math.round(over * top.a + base * (1 - top.a));
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

// WCAG 2.x relative luminance, with the sRGB threshold as the specification writes it.
function luminance({ r, g, b }: Rgba): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(first: Rgba, second: Rgba): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

export type PairKind = 'text' | 'ui';

export interface ColourPair {
  kind: PairKind;
  /** Custom property names, for example `--color-text`. */
  foreground: string;
  background: string;
}

export interface PairFailure {
  pair: ColourPair;
  ratio: number;
  minimum: number;
}

/** The pairs of a theme whose ratio is below the minimum for their kind; a missing token is an error. */
export function failingPairs(
  tokens: ReadonlyMap<string, string>,
  pairs: readonly ColourPair[],
  minimum: Readonly<Record<PairKind, number>>,
): PairFailure[] {
  const failures: PairFailure[] = [];
  for (const pair of pairs) {
    const foreground = tokens.get(pair.foreground);
    const background = tokens.get(pair.background);
    if (foreground === undefined || background === undefined) {
      throw new Error(`pair ${pair.foreground} on ${pair.background} names a token the theme does not declare`);
    }
    const ratio = contrastRatio(parseHex(foreground), parseHex(background));
    if (ratio < minimum[pair.kind]) failures.push({ pair, ratio, minimum: minimum[pair.kind] });
  }
  return failures;
}

/** CSS named colours; component stylesheets must take colours from tokens, so these are refused there. */
export const NAMED_COLOURS = [
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond', 'blue',
  'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk',
  'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki',
  'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue',
  'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite',
  'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory',
  'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen',
  'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen',
  'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen',
  'mediumslateblue', 'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream',
  'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid',
  'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum',
  'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown',
  'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen',
  'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow',
  'yellowgreen',
] as const;
