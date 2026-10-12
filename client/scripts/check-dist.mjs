// Fails the build when dist/index.html holds anything the bridge's CSP (D15) blocks or could let slip
// past it: inline scripts or styles, style and event-handler attributes, any foreign-origin URL, and in an
// attribute value a character reference, a tab, a newline or a backslash (this scan neither decodes the
// first nor strips the second and third nor reads the last as a slash, as a browser does, so any of them
// could hide a URL).
// It reads index.html only; dist/assets/* is bundler output and is not read here.
//
// Usage: node scripts/check-dist.mjs [distDir]   (default: ../dist next to this script)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_VIOLATIONS = 1;
const EXIT_UNREADABLE = 2;
const MAX_SHOWN = 60;

// A start tag. Quoted attribute values may contain ">", so they are matched as whole units.
const START_TAG = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const TAG_OPENER = /<[a-zA-Z]/g;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// What the CSP's 'self' sources cannot cover. A scheme-qualified URL is foreign wherever it appears,
// text and comments included, because the rule is "any foreign-origin URL in index.html". Protocol-relative
// URLs and the data:, blob: and javascript: schemes only mean something as attribute values.
// Plain relative paths such as /assets/x.js are fine.
const ABSOLUTE_URL = /(?:https?|wss?|ftp):\/\/[^\s"'<>)]*/gi;
const ESCAPING_ATTRIBUTE_URL = /(?:^|[\s,;=])\/\/[^\s,;]|^\s*(?:data|blob|javascript|vbscript|file):/i;
const EVENT_HANDLER = /^on[a-z]/;

function shown(value) {
  return value.length > MAX_SHOWN ? `${value.slice(0, MAX_SHOWN - 3)}...` : value;
}

function scan(html) {
  const problems = [];
  let loadedScripts = 0;
  let tags = 0;

  for (const tag of html.matchAll(START_TAG)) {
    tags += 1;
    const name = tag[1].toLowerCase();
    const attributes = [...tag[2].matchAll(ATTRIBUTE)].map((match) => ({
      name: match[1].toLowerCase(),
      value: match[2] ?? match[3] ?? match[4] ?? '',
    }));

    if (name === 'style') problems.push('inline <style> element');

    if (name === 'script') {
      const hasSrc = attributes.some((attribute) => attribute.name === 'src');
      const afterTag = html.slice(tag.index + tag[0].length);
      const closeAt = afterTag.search(/<\/script/i);
      const body = closeAt === -1 ? afterTag : afterTag.slice(0, closeAt);
      if (!hasSrc || body.trim() !== '') problems.push('inline script (a <script> without src, or with a body)');
      if (hasSrc) loadedScripts += 1;
    }

    for (const attribute of attributes) {
      if (attribute.name === 'style') problems.push(`style attribute on <${name}>`);
      if (EVENT_HANDLER.test(attribute.name)) problems.push(`event-handler attribute ${attribute.name} on <${name}>`);
      // A browser decodes character references before it reads a URL (`&#104;ttps://...`, `https&colon;//...`)
      // and this scan does not, so one in an attribute value could hide any URL rule below. Vite writes none
      // into index.html, so one is a failure rather than something to decode: there are more than 2,000 names.
      if (attribute.value.includes('&')) {
        problems.push(`character reference in ${attribute.name}="${shown(attribute.value)}" on <${name}>`);
      }
      // The URL parser also removes ASCII tabs and newlines before it reads a scheme, so `h<TAB>ttps://` is an
      // https URL to a browser and nothing to the patterns below, which want the scheme in one piece.
      if (/[\t\n\r]/.test(attribute.value)) {
        problems.push(`control character in ${attribute.name}=${JSON.stringify(shown(attribute.value))} on <${name}>`);
      }
      // And it reads a backslash as a slash, so `\\cdn.example/app.js` is a protocol-relative URL to a browser and
      // matches neither pattern below. Vite writes none.
      if (attribute.value.includes('\\')) {
        problems.push(`backslash in ${attribute.name}=${JSON.stringify(shown(attribute.value))} on <${name}>`);
      }
      if (ESCAPING_ATTRIBUTE_URL.test(attribute.value)) {
        problems.push(`foreign-origin URL in ${attribute.name}="${shown(attribute.value)}" on <${name}>`);
      }
    }
  }

  for (const url of new Set(html.match(ABSOLUTE_URL) ?? [])) problems.push(`foreign-origin URL: ${shown(url)}`);

  // A tag the pattern above could not parse (for example an unterminated quote) would be invisible
  // to every rule, so an unmatched opener is itself a failure.
  const openers = (html.match(TAG_OPENER) ?? []).length;
  if (openers !== tags) problems.push(`markup this check cannot parse (${openers} tag openers, ${tags} parsed)`);

  // Without this, an empty or mis-built index.html would pass every rule above.
  if (loadedScripts === 0) problems.push('no <script src> loads the app; the build looks empty');

  return problems;
}

const distDir = process.argv[2] ?? fileURLToPath(new URL('../dist', import.meta.url));
const file = join(distDir, 'index.html');

let html;
try {
  html = readFileSync(file, 'utf8');
} catch (error) {
  console.error(`check:dist: cannot read ${file}: ${error.code ?? error.message}`);
  process.exit(EXIT_UNREADABLE);
}

const problems = scan(html);
if (problems.length > 0) {
  for (const problem of problems) console.error(`check:dist: index.html: ${problem}`);
  process.exit(EXIT_VIOLATIONS);
}
console.log(`check:dist: OK (${file})`);
