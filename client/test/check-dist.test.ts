// @vitest-environment node
// Black-box tests for scripts/check-dist.mjs, the gate that keeps dist/index.html compatible with the bridge's CSP.
// Each case asserts the message as well as the exit code: a missing script also exits 1, which must not pass.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/check-dist.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'chatter-check-dist-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function check(html: string | null): { code: number | null; output: string } {
  const dir = join(scratch, String(counter++));
  mkdirSync(dir);
  if (html !== null) writeFileSync(join(dir, 'index.html'), html);
  const run = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  return { code: run.status, output: `${run.stdout}${run.stderr}` };
}

// The shape Vite emits: same-origin module script and stylesheet, nothing inline.
function page(extraBody = ''): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>Chatter</title>',
    '<script type="module" crossorigin src="/assets/index-AbC123.js"></script>',
    '<link rel="stylesheet" crossorigin href="/assets/index-AbC123.css">',
    '</head>',
    '<body>',
    '<div id="app"></div>',
    extraBody,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

describe('check-dist', () => {
  it('accepts a page with only same-origin script and stylesheet references', () => {
    const result = check(page());
    expect(result.output).toMatch(/check:dist.*OK/);
    expect(result.code).toBe(0);
  });

  const violations: Array<[string, string, RegExp]> = [
    ['an inline script body', '<script>window.boot = 1</script>', /inline script/i],
    ['an inline module script body', '<script type="module">import "/assets/x.js"</script>', /inline script/i],
    ['a script element without src', '<script></script>', /inline script/i],
    ['an upper-case script element', '<SCRIPT>boot()</SCRIPT>', /inline script/i],
    ['an inline style element', '<style>body { color: red }</style>', /inline <style>/i],
    ['a style attribute', '<p style="color: red">x</p>', /style attribute/i],
    ['an upper-case style attribute', '<p STYLE="color: red">x</p>', /style attribute/i],
    ['an event-handler attribute', '<button onclick="go()">x</button>', /event-handler/i],
    ['an upper-case event-handler attribute', '<button ONCLICK="go()">x</button>', /event-handler/i],
    ['an unquoted event-handler attribute', '<button onclick=go()>x</button>', /event-handler/i],
    ['a handler after an attribute value containing ">"', '<p title="a > b" onclick="go()">x</p>', /event-handler/i],
    ['an https URL', '<img src="https://cdn.example.com/a.png">', /foreign-origin URL/i],
    ['an http stylesheet', '<link rel="stylesheet" href="http://example.com/a.css">', /foreign-origin URL/i],
    ['a protocol-relative script', '<script src="//cdn.example.com/x.js"></script>', /foreign-origin URL/i],
    ['a data URI', '<img src="data:image/png;base64,AAAA">', /foreign-origin URL/i],
    ['a javascript URI', '<a href="javascript:void(0)">x</a>', /foreign-origin URL/i],
    ['a URL inside a meta refresh', '<meta http-equiv="refresh" content="0;url=https://example.com/">', /foreign-origin URL/i],
    // The rule is "any foreign-origin URL in index.html", so text and comments count, not only attributes.
    ['a URL in text', '<p>Docs live at https://example.com/docs</p>', /foreign-origin URL/i],
    ['a URL in a comment', '<!-- served from https://cdn.example.com/x.js -->', /foreign-origin URL/i],
    ['a tag with an unterminated quote, which would hide it from every rule', '<p title="oops>', /cannot parse/i],
  ];
  it.each(violations)('fails on %s', (_name, fragment, message) => {
    const result = check(page(fragment));
    expect(result.output).toMatch(message);
    expect(result.code).toBe(1);
  });

  it('reports every violation, not only the first', () => {
    const result = check(page('<style>a{}</style><p style="x">y</p><script>z()</script>'));
    expect(result.output).toMatch(/inline <style>/i);
    expect(result.output).toMatch(/style attribute/i);
    expect(result.output).toMatch(/inline script/i);
    expect(result.code).toBe(1);
  });

  it('fails when nothing loads a script, so an empty build cannot pass', () => {
    const result = check('<!doctype html><html lang="en"><head><title>Chatter</title></head><body></body></html>');
    expect(result.output).toMatch(/no <script src>/i);
    expect(result.code).toBe(1);
  });

  it('fails with its own exit code when index.html is missing', () => {
    const result = check(null);
    expect(result.output).toMatch(/index\.html/);
    expect(result.code).toBe(2);
  });
});
