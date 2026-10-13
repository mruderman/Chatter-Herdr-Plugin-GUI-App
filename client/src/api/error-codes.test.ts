// @vitest-environment node
// ERROR_CODES has to be the codes the bridge can send, no more and no fewer: a code the client lacks is
// one it would treat as a stranger's (a proxy's), and a code the bridge no longer sends is a word that
// nothing can say. The bridge is only read here, never run: every `new HttpError(status, code, ...)` in
// bridge/src, the catch-all of its error handler and the static server's refusal table. A code written
// in a form this reader does not know fails the test with its file and line instead of being skipped,
// because a skipped code is exactly the one the client would then miss.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './errors';

interface Site {
  readonly code: string;
  readonly where: string;
}

const CODE_LITERAL = /^(['"`])([a-z][a-z0-9_]*)\1$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// What the bridge passes along from an HttpError it already caught, which the constructor sites have read.
const OWN_CODE = /^[A-Za-z_$][\w$]*\.code$/;
const HTTP_ERROR = /new\s+HttpError\s*\(/g;
const WHOLE_LINE_COMMENT = /^\s*(\/\/|\/\*|\*)/;
// An object key, not the `code` of `e.code ? a : b`.
const CODE_KEY = /(?<![.\w$])code\s*:/g;
const MESSAGE_KEY = /\bmessage\s*:/;
// A `code:` with no `message:` this close after it is some other object (a process result, say).
const BODY_REACH = 160;

function unreadable(where: string, what: string, text: string): never {
  throw new Error(
    `${where}: this test cannot read ${what} "${text.replace(/\s+/g, ' ').trim()}". Write the code as a string literal, `
      + 'or as a constant of the same file that is a string literal, or teach error-codes.test.ts the new form.',
  );
}

// Blanks the comments and keeps every other character where it was, so that a line number still points
// at the right line. Strings are matched first, so a `//` inside one (a URL) is not taken for a comment.
const TOKENS = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
function withoutComments(source: string): string {
  return source.replace(TOKENS, (token) => (token.startsWith('//') || token.startsWith('/*') ? token.replace(/[^\n]/g, ' ') : token));
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** The first `count` top-level arguments of the call whose `(` ends just before `from`; null if it never closes. */
function leadingArguments(text: string, from: number, count: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let start = from;
  let quote = '';
  for (let i = from; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if ('([{'.includes(char)) {
      depth += 1;
    } else if (')]}'.includes(char)) {
      if (depth === 0) return [...args, text.slice(start, i)];
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
      if (args.length === count) return args;
    }
  }
  return null;
}

/** `const NAME = 'literal';` anywhere in the file: how a code can be passed as a name. */
function constantsOf(text: string): Map<string, string> {
  const constants = new Map<string, string>();
  for (const match of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*('[^'\n]*'|"[^"\n]*"|`[^`$\n]*`)\s*;/g)) {
    const code = CODE_LITERAL.exec(match[2] ?? '')?.[2];
    if (match[1] !== undefined && code !== undefined) constants.set(match[1], code);
  }
  return constants;
}

function codeOf(expression: string, constants: ReadonlyMap<string, string>): string | null {
  const text = expression.trim();
  const literal = CODE_LITERAL.exec(text)?.[2];
  if (literal !== undefined) return literal;
  return IDENTIFIER.test(text) ? (constants.get(text) ?? null) : null;
}

/** Every code that `source` (the text of one bridge file called `file`) can put in an error answer. */
function readCodes(file: string, source: string): Site[] {
  const text = withoutComments(source);
  const constants = constantsOf(text);
  const sites: Site[] = [];

  let constructed = 0;
  for (const match of text.matchAll(HTTP_ERROR)) {
    constructed += 1;
    const where = `${file}:${lineOf(text, match.index)}`;
    const args = leadingArguments(text, match.index + match[0].length, 2);
    const expression = args?.[1];
    if (expression === undefined) unreadable(where, 'the arguments of', text.slice(match.index, match.index + 60));
    const code = codeOf(expression, constants);
    if (code === null) unreadable(where, 'the code of an HttpError, which is', expression);
    sites.push({ code, where });
  }
  // A quote this reader pairs wrongly would swallow code without a word, so the constructors are counted
  // a second way, on the lines that are not whole-line comments. They differ only when a quote is
  // misread or a comment after code names the constructor, and the test then says so.
  const written = (source.split('\n').filter((line) => !WHOLE_LINE_COMMENT.test(line)).join('\n').match(HTTP_ERROR) ?? []).length;
  if (written !== constructed) {
    throw new Error(`${file}: "new HttpError(" is written ${written} times outside whole-line comments but ${constructed} are code. A comment after code that names it, or a quote this reader misreads, hides or adds one: reword the comment or teach error-codes.test.ts the form.`);
  }

  // The answers that are not thrown as an HttpError: an object with a code and a message.
  for (const match of text.matchAll(CODE_KEY)) {
    const rest = text.slice(match.index + match[0].length);
    const end = rest.search(MESSAGE_KEY);
    if (end === -1 || end > BODY_REACH) continue;
    const where = `${file}:${lineOf(text, match.index)}`;
    const expression = rest.slice(0, end).replace(/,\s*$/, '').trim();
    const direct = codeOf(expression, constants);
    if (direct !== null) {
      sites.push({ code: direct, where });
      continue;
    }
    // `test ? e.code : 'internal'`: the handler's own code when the error is an HttpError, else the catch-all.
    const choice = /^[^?]+\?\s*([^:]+?)\s*:\s*(.+)$/s.exec(expression);
    const whenTrue = choice?.[1]?.trim();
    const whenFalse = choice?.[2] === undefined ? null : codeOf(choice[2], constants);
    if (whenTrue === undefined || whenFalse === null) unreadable(where, 'the code of an error answer, which is', expression);
    const first = codeOf(whenTrue, constants);
    if (first === null && !OWN_CODE.test(whenTrue)) unreadable(where, 'the code of an error answer, which is', expression);
    if (first !== null) sites.push({ code: first, where });
    sites.push({ code: whenFalse, where });
  }
  return sites;
}

// A variable, not a literal inside `new URL(..., import.meta.url)`, which Vite would take for an asset.
const BRIDGE_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bridge/src');

function readBridge(dir: string): { readonly files: string[]; readonly sites: Site[] } {
  const entries = readdirSync(dir, { withFileTypes: true });
  const nested = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (nested.length > 0) throw new Error(`${dir} has a folder (${nested.join(', ')}): this test reads only the .js files directly in bridge/src, so teach it to descend.`);
  const files = entries.filter((entry) => entry.name.endsWith('.js')).map((entry) => entry.name).sort();
  const sites = files.flatMap((name) => readCodes(`bridge/src/${name}`, readFileSync(path.join(dir, name), 'utf8')));
  return { files, sites };
}

describe('reading the codes of a bridge file', () => {
  const codes = (source: string): string[] => readCodes('x.js', source).map((site) => site.code);

  it('reads a string literal of either quote, or a template without a placeholder, as the second argument', () => {
    expect(codes(`throw new HttpError(400, 'bad_one', 'm'); throw new HttpError(401, "bad_two", 'm'); throw new HttpError(402, \`bad_three\`, 'm');`)).toEqual(['bad_one', 'bad_two', 'bad_three']);
  });

  it('reads a call that spreads over lines, and a message that holds commas, brackets and quotes', () => {
    expect(codes("throw new HttpError(\n  409,\n  'bad_wrapped',\n  `a, (b) and 'c' ${x.join(', ')}`,\n);")).toEqual(['bad_wrapped']);
  });

  it('resolves a code passed as the name of a constant of the same file', () => {
    expect(codes("const AMBIGUOUS = 'bad_named';\nthrow new HttpError(409, AMBIGUOUS, 'm');")).toEqual(['bad_named']);
  });

  it('leaves a comment, and a comment-like text inside a string, alone', () => {
    expect(codes("// throw new HttpError(400, 'in_a_line_comment', 'm');\n/* new HttpError(400, 'in_a_block', 'm') */\nconst url = 'http://a.example/x'; throw new HttpError(400, 'real', 'm');")).toEqual(['real']);
  });

  it('reads the code and the catch-all of an error answer, and the codes of a table of refusals', () => {
    expect(codes("send(res, status, { error: { code: e instanceof HttpError ? e.code : 'bad_fallback', message: 'm' } });")).toEqual(['bad_fallback']);
    expect(codes("const R = { 400: { code: 'bad_path', message: 'p' }, 404: { code: 'bad_missing', message: 'q' } };")).toEqual(['bad_path', 'bad_missing']);
  });

  it('ignores an object that has a code and no message', () => {
    expect(codes('return { code: 1, stdout: out };')).toEqual([]);
  });

  it.each([
    ['a template with a placeholder', 'throw new HttpError(400, `bad_${kind}`, "m");', 'x.js:1', '`bad_${kind}`'],
    ['a call', 'throw new HttpError(400, codeFor(kind), "m");', 'x.js:1', 'codeFor(kind)'],
    ['a name that is no constant of the file', 'throw new HttpError(\n  400,\n  elsewhere,\n  "m");', 'x.js:1', 'elsewhere'],
    ['a name of a constant that is not a plain string', 'const C = `a${b}`;\nthrow new HttpError(400, C, "m");', 'x.js:2', 'C'],
    ['an upper-case or hyphenated word', 'throw new HttpError(400, "Bad-Code", "m");', 'x.js:1', '"Bad-Code"'],
    ['a code taken from an answer', 'send(res, 400, { code: e.status > 400 ? other : "x", message: "m" });', 'x.js:1', 'e.status > 400 ? other : "x"'],
    ['a code that is not a literal', 'send(res, 400, { code: pick(e), message: "m" });', 'x.js:1', 'pick(e)'],
  ])('fails with the file and line, and says what it could not read, for %s', (_name, source, where, shown) => {
    let message = '';
    try {
      readCodes('x.js', source);
    } catch (failure) {
      message = failure instanceof Error ? failure.message : String(failure);
    }
    expect(message).toContain(`${where}: this test cannot read`);
    expect(message).toContain(shown);
    expect(message).toContain('teach error-codes.test.ts');
  });

  it('fails when a comment after code names the constructor, or a call never closes, rather than miscount', () => {
    expect(() => readCodes('x.js', "throw new HttpError(400, 'b', 'm'); // was new HttpError(400, 'a', 'm')")).toThrow('written 2 times outside whole-line comments but 1 are code');
    expect(() => readCodes('x.js', "throw new HttpError(400, 'b'")).toThrow('x.js:1: this test cannot read the arguments of');
  });
});

describe('ERROR_CODES against the codes that bridge/src can send', () => {
  // Read when a test first needs it, so that a form this reader cannot read fails these tests with its
  // message, and the tests of the reader above still run.
  let read: { readonly files: string[]; readonly where: Map<string, string[]> } | undefined;
  const bridge = (): NonNullable<typeof read> => {
    if (read === undefined) {
      const { files, sites } = readBridge(BRIDGE_SRC);
      const where = new Map<string, string[]>();
      for (const site of sites) where.set(site.code, [...(where.get(site.code) ?? []), site.where]);
      read = { files, where };
    }
    return read;
  };
  const client = new Set<string>(Object.values(ERROR_CODES));

  it('has read the bridge: its files, and a code from each way of sending one', () => {
    // A reader that found nothing would make both comparisons below pass for the wrong reason.
    const { files, where } = bridge();
    expect(files).toEqual(expect.arrayContaining(['auth.js', 'policy.js', 'server.js', 'static.js', 'store.js']));
    expect(where.get('internal')?.[0]).toMatch(/^bridge\/src\/server\.js:\d+$/);
    expect(where.get('not_found')?.some((site) => site.startsWith('bridge/src/static.js:'))).toBe(true);
    expect(where.get('bad_token')?.[0]).toMatch(/^bridge\/src\/auth\.js:\d+$/);
  });

  it('lists every code the bridge can send', () => {
    const lacking = [...bridge().where].filter(([code]) => !client.has(code)).map(([code, sites]) => `${code} (${sites.join(', ')})`);
    expect(lacking, 'the bridge sends these, ERROR_CODES in client/src/api/errors.ts lacks them').toEqual([]);
  });

  it('lists no code that the bridge never sends', () => {
    const stale = [...client].filter((code) => !bridge().where.has(code));
    expect(stale, 'ERROR_CODES lists these, and nothing in bridge/src sends them').toEqual([]);
  });

  it('lists each code once', () => {
    const values = Object.values(ERROR_CODES);
    expect(values.filter((code, index) => values.indexOf(code) !== index)).toEqual([]);
  });
});
