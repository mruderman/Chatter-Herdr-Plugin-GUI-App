import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { screen } from '@testing-library/dom';
import { act } from 'preact/test-utils';
import { describe, expect, it } from 'vitest';
import { render } from '../../../test/render';
import { createFakeStore, type FakeStore } from '../../state/fake';
import type { StoreSnapshot } from '../../state/types';
import { NAMED_COLOURS, parseCss, readStyle, type CssRule } from '../../styles/css-test-utils';
import { expectNoAxeViolations, setupUser } from '../shell/test-utils';
import { ChatView } from './ChatView';
import { Live, clockAfterRecordings } from './feed/test-harness';

// Roles, names and texts are written out as docs/ui-contract.md has them, not read from constants.

/** Stands in for the composer (T8b): the form and the field the contract names, with the skip-link id. */
function StubComposer() {
  return (
    <form aria-label="Message composer">
      <label for="chat-message-box">Message</label>
      <textarea id="chat-message-box" />
      <button type="button">Send</button>
    </form>
  );
}

/** The view inside <main>, as the shell shows it. */
function renderChat(store: FakeStore, override: Partial<StoreSnapshot> = {}): void {
  render(
    <main id="main-content" tabIndex={-1}>
      <Live
        store={store}
        view={(snapshot) => <ChatView snapshot={{ ...snapshot, ...override }} store={store} composer={<StubComposer />} timeZone="UTC" />}
      />
    </main>,
  );
}

const follows = (earlier: Element, later: Element): boolean => (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('the Chat view (ui-contract sections 2, 3 and 5)', () => {
  it('has the h1 "Chat", then the Conversations navigation, the Messages log and the composer, in that order', () => {
    renderChat(createFakeStore({ as: 'thom' }));
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Chat');
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    const log = screen.getByRole('log', { name: 'Messages' });
    const composer = screen.getByRole('form', { name: 'Message composer' });
    expect(follows(heading, nav)).toBe(true);
    expect(follows(nav, log)).toBe(true);
    expect(follows(log, composer)).toBe(true);
  });

  it('heads the feed with the open conversation\'s label', async () => {
    const user = setupUser();
    renderChat(createFakeStore({ as: 'thom' }));
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Conversations', '#chat']);
    await user.click(screen.getByRole('button', { name: 'DM with grace' }));
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Conversations', 'DM with grace']);
  });

  it('runs Tab through the conversations, the feed, then the composer', async () => {
    const user = setupUser();
    renderChat(createFakeStore({ as: 'thom' }));
    const expected = [
      screen.getByRole('button', { name: '#chat' }),
      screen.getByRole('button', { name: 'DM with codex' }),
      screen.getByRole('button', { name: 'DM with grace' }),
      screen.getByRole('button', { name: 'DM with mira' }),
      screen.getByRole('log', { name: 'Messages' }),
      screen.getByLabelText('Message'),
      screen.getByRole('button', { name: 'Send' }),
    ];
    for (const element of expected) {
      await user.tab();
      expect(document.activeElement).toBe(element);
    }
  });

  it('puts "Load older messages" between the conversations and the feed when there is more', async () => {
    const user = setupUser();
    // Only the newest five messages are loaded, all in #chat, so "#chat" is the only conversation yet.
    renderChat(createFakeStore({ as: 'thom', pageSize: 5 }));
    screen.getByRole('button', { name: '#chat' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Load older messages' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('log', { name: 'Messages' }));
  });

  it('carries the Announcements region', () => {
    const store = createFakeStore({ as: 'thom', clock: clockAfterRecordings() });
    renderChat(store);
    act(() => {
      store.receive({ from: 'grace', body: 'hello there' });
    });
    expect(screen.getByRole('status', { name: 'Announcements' }).textContent).toBe('grace: hello there');
  });
});

describe('every state: the rules that hold everywhere', () => {
  const states: Array<[string, () => void]> = [
    ['#chat with unread messages and the marker', () => renderChat(createFakeStore({ as: 'thom' }))],
    ['#chat with older messages to load', () => renderChat(createFakeStore({ as: 'thom', pageSize: 5 }))],
    ['the member\'s DM', () => {
      const store = createFakeStore({ as: 'thom' });
      const dm = store.getSnapshot().conversations.find((conversation) => conversation.label === 'DM with mira');
      store.selectConversation(dm?.id ?? '');
      renderChat(store);
    }],
    ['the admin\'s view of a DM between two others', () => {
      const store = createFakeStore({ as: 'flan' });
      const observed = store.getSnapshot().conversations.find((conversation) => conversation.label === 'DM grace to thom');
      store.selectConversation(observed?.id ?? '');
      renderChat(store);
    }],
    ['an empty conversation', () => renderChat(createFakeStore({ as: 'kieran' }), { messages: [], newMarkerBeforeId: null })],
    ['a conversation still loading', () => renderChat(createFakeStore({ as: 'kieran' }), { messages: [], newMarkerBeforeId: null, connection: 'syncing' })],
    ['no repository', () => renderChat(createFakeStore({ as: 'kieran' }), { messages: [], conversations: [], selectedConversation: null, selectedRepo: null, repos: [] })],
  ];

  it.each(states)('%s: axe finds no violation in its structure', async (_name, show) => {
    show();
    await expectNoAxeViolations();
  });

  it.each(states)('%s: no style attribute, no "bot", no link, image or script', (_name, show) => {
    show();
    expect(document.body.querySelectorAll('[style]')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/\bbot\b/i);
    expect(document.body.querySelectorAll('a, img, script, iframe, object, embed')).toHaveLength(0);
  });
});

describe('the chat stylesheets keep the design system\'s rules', () => {
  const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const SHEETS = {
    'ChatView.css': read('./ChatView.css'),
    'conversations.css': read('./conversations/conversations.css'),
    'feed.css': read('./feed/feed.css'),
  } as const;
  const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const values = (css: string): string[] => parseCss(css).flatMap((rule) => [...rule.declarations.values()]);
  const declared = new Set<string>();
  for (const name of ['./tokens.css', './base.css', './layout.css', './components.css']) {
    for (const match of withoutComments(readStyle(name)).matchAll(/(--[a-z0-9-]+)\s*:/gi)) if (match[1]) declared.add(match[1]);
  }

  it.each(Object.entries(SHEETS))('%s: colours only from the tokens', (_name, css) => {
    const found: string[] = [];
    for (const value of values(css)) {
      if (/#[0-9a-f]{3,8}\b/i.test(value)) found.push(value);
      if (/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i.test(value)) found.push(value);
      for (const word of value.toLowerCase().split(/[^a-z-]+/)) if ((NAMED_COLOURS as readonly string[]).includes(word)) found.push(value);
    }
    expect(values(css).length).toBeGreaterThan(5);
    expect(found).toEqual([]);
  });

  it.each(Object.entries(SHEETS))('%s: only custom properties the design system defines', (_name, css) => {
    const used = [...withoutComments(css).matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((match) => match[1] ?? '');
    expect(used.filter((name) => !declared.has(name))).toEqual([]);
  });

  it.each(Object.entries(SHEETS))('%s: nothing that hides focus, fades contrast, pins to the viewport, loads anything or moves smoothly', (_name, css) => {
    const source = withoutComments(css);
    expect(source).not.toContain('!important');
    expect(source).not.toMatch(/https?:|\/\/|url\(|@import|@font-face/i);
    expect(source).not.toMatch(/\bopacity\s*:(?!\s*1\s*[;}])/);
    expect(source).not.toMatch(/scroll-behavior\s*:\s*smooth/);
    for (const rule of parseCss(css)) {
      expect(rule.declarations.get('outline') ?? '', rule.selector).not.toMatch(/^(none|0)$/);
      expect(rule.declarations.get('position') ?? '', rule.selector).not.toMatch(/^(fixed|sticky)$/);
    }
  });

  const rule = (css: string, selector: string, atRule = ''): CssRule | undefined =>
    parseCss(css).find((candidate) => candidate.selector === selector && candidate.atRules.join(' ') === atRule);

  it('marks the selected conversation with weight and a bar, not only a colour, and underlines it in forced colours', () => {
    const css = SHEETS['conversations.css'];
    const base = rule(css, '.conversations__button');
    const selected = rule(css, ".conversations__button[aria-current='true']");
    expect(base?.declarations.get('border-inline-start')).toMatch(/^[3-9]px solid /);
    expect(base?.declarations.get('font-weight')).toBe('400');
    expect(selected?.declarations.get('font-weight')).toBe('700');
    expect(selected?.declarations.get('border-inline-start-color')).toBe('var(--color-accent)');
    const forced = rule(css, ".conversations__button[aria-current='true']", '@media (forced-colors: active)');
    expect(forced?.declarations.get('text-decoration')).toBe('underline');
  });

  it('shows bodies as written: line breaks kept, long words wrapped', () => {
    const body = rule(SHEETS['feed.css'], '.message__body');
    expect(body?.declarations.get('white-space')).toBe('pre-wrap');
    expect(body?.declarations.get('overflow-wrap')).toBe('anywhere');
  });

  it('scrolls the log by itself and leaves the reading position to the feed, not to the browser\'s anchoring', () => {
    const log = rule(SHEETS['feed.css'], '.feed__log');
    expect(log?.declarations.get('overflow-y')).toBe('auto');
    expect(log?.declarations.get('overflow-anchor')).toBe('none');
  });

  it('makes the log the containing block of what it holds, so a hidden time in it cannot stretch the page', () => {
    // The visually hidden <time> of a message that continues a group is `position: absolute` (components.css).
    // Without a positioned log each one stretched the page's scroll height by its place in the log.
    expect(rule(SHEETS['feed.css'], '.feed__log')?.declarations.get('position')).toBe('relative');
  });

  it('gives the log a floor and the height the window leaves, not a height of its own', () => {
    const log = rule(SHEETS['feed.css'], '.feed__log');
    expect(log?.declarations.get('min-block-size')).toBe('12rem');
    // A flex basis of 0 keeps the length of the feed out of the page's height; a block-size would bring a fixed one back.
    expect(log?.declarations.get('flex')).toBe('1 1 0');
    expect(log?.declarations.has('block-size')).toBe(false);
  });

  it('is a column of growing boxes from the shell\'s <main> down to the log, and the conversation list cannot set its height', () => {
    expect(rule(readStyle('./layout.css'), '.app-main')?.declarations.get('display')).toBe('flex');
    for (const [css, selector] of [
      [SHEETS['ChatView.css'], '.chat'],
      [SHEETS['ChatView.css'], '.chat__layout'],
      [SHEETS['feed.css'], '.feed'],
    ] as const) {
      expect(rule(css, selector)?.declarations.get('flex'), selector).toBe('1 1 auto');
    }
    for (const [css, selector] of [
      [SHEETS['ChatView.css'], '.chat__conversation'],
      [SHEETS['feed.css'], '.feed'],
    ] as const) {
      expect(rule(css, selector)?.declarations.get('flex-direction'), selector).toBe('column');
    }
    // Side by side the list is a scroll box inside a column that counts as empty to the grid.
    const column = rule(SHEETS['conversations.css'], '.conversations', '@media (min-width: 48rem)');
    expect(column?.declarations.get('contain')).toBe('size');
    expect(rule(SHEETS['conversations.css'], '.conversations__list', '@media (min-width: 48rem)')?.declarations.get('overflow-y')).toBe('auto');
  });

  it('gives a mention a bar beside it as well as its label', () => {
    expect(rule(SHEETS['feed.css'], '.message--mentions-you')?.declarations.get('border-inline-start')).toMatch(/^[3-9]px solid /);
  });
});
