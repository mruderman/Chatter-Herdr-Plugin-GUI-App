// @vitest-environment node
// The guards against every recorded answer of the real bridge (client/test/fixtures/api.json),
// and against damaged copies of them: each damage must be refused with the field named.
import { describe, expect, it } from 'vitest';
import { body, exchange, EXCHANGE_NAMES } from '../../test/fixtures/recorded';
import { ProtocolError } from './errors';
import {
  parseAddMemberResult,
  parseAudit,
  parseBoard,
  parseConversations,
  parseDirectory,
  parseErrorBody,
  parseHealth,
  parseMe,
  parseMemberResult,
  parseMembers,
  parseMessagesPage,
  parseReadResult,
  parseRepos,
  parseSendResult,
  parseTokenResult,
} from './guards';
import { CHANNEL } from './types';

// Which guard reads which recorded answer. A new 2xx recording without a guard fails below.
const PARSERS: ReadonlyArray<readonly [RegExp, (value: unknown) => unknown]> = [
  [/^healthz$/, parseHealth],
  [/^me-/, parseMe],
  [/^directory$/, parseDirectory],
  [/^repos-/, parseRepos],
  [/^messages-/, parseMessagesPage],
  [/^post-/, parseSendResult],
  [/^board$/, parseBoard],
  [/^read(-|$)/, parseReadResult],
  [/^members-list$/, parseMembers],
  [/^members-add-/, parseAddMemberResult],
  [/^members-(update|revoke)$/, parseMemberResult],
  [/^members-rotate-token$/, parseTokenResult],
  [/^audit$/, parseAudit],
];

const successes = EXCHANGE_NAMES.filter((name) => {
  const recorded = exchange(name);
  return recorded.status < 300 && recorded.file === undefined;
});
const refusals = EXCHANGE_NAMES.filter((name) => exchange(name).status >= 400);

function parserFor(name: string): (value: unknown) => unknown {
  const entry = PARSERS.find(([pattern]) => pattern.test(name));
  if (!entry) throw new Error(`no guard covers the recorded exchange "${name}"`);
  return entry[1];
}

/** A deep copy of a recorded body with one change, made by `edit`. */
function damaged(name: string, edit: (copy: Record<string, unknown>) => void): unknown {
  const copy = structuredClone(body(name)) as Record<string, unknown>;
  edit(copy);
  return copy;
}

function refusedField(parse: (value: unknown) => unknown, value: unknown): string {
  try {
    parse(value);
  } catch (failure) {
    if (failure instanceof ProtocolError) return failure.field;
    throw failure;
  }
  throw new Error('the guard accepted a damaged answer');
}

describe('guards on the recorded answers', () => {
  it('has recordings to check', () => {
    expect(successes.length).toBeGreaterThan(30);
    expect(refusals.length).toBeGreaterThan(20);
  });

  it.each(successes)('accepts the recorded answer to %s', (name) => {
    expect(() => parserFor(name)(body(name))).not.toThrow();
  });

  it.each(refusals)('reads the error shape of %s', (name) => {
    const error = parseErrorBody(body(name));
    expect(error?.error.code).toMatch(/^[a-z_]+$/);
    expect(error?.error.message.length).toBeGreaterThan(0);
  });

  it('keeps message pages exactly as recorded, since they carry no extra fields', () => {
    for (const name of successes.filter((n) => n.startsWith('messages-'))) {
      expect(parseMessagesPage(body(name))).toEqual(body(name));
    }
  });

  it('keeps @everyone out of mentions and in its own flag', () => {
    const page = parseMessagesPage(body('messages-flan'));
    const everyone = page.messages.filter((message) => message.everyone);
    expect(everyone.map((message) => message.body)).toEqual(['@everyone standup in five']);
    expect(page.messages.flatMap((message) => message.mentions)).not.toContain('everyone');
  });

  it('shows each member only #chat and their own DMs, and the admin all of them', () => {
    const page = (who: string) => parseMessagesPage(body(`messages-${who}`)).messages;
    for (const who of ['thom', 'mira', 'grace', 'kieran']) {
      for (const message of page(who)) {
        expect([CHANNEL, who].includes(message.to) || message.from === who).toBe(true);
      }
    }
    expect(page('kieran').every((message) => message.to === CHANNEL)).toBe(true);
    expect(page('flan').some((message) => message.to !== CHANNEL && message.from !== 'flan' && message.to !== 'flan')).toBe(true);
  });

  it('drops the host paths Chatter reports for agents and turns its zoneless times into UTC', () => {
    const recordedAgent = (body('board') as { agents: Array<Record<string, unknown>> }).agents[0];
    expect(recordedAgent?.['repo_root']).toBeTypeOf('string');
    expect(recordedAgent?.['registered_at']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const agent = parseBoard(body('board')).agents[0];
    expect(agent).not.toHaveProperty('repo_root');
    expect(agent).not.toHaveProperty('cwd');
    expect(agent).not.toHaveProperty('pane_id');
    expect(agent?.registered_at).toBe(`${String(recordedAgent?.['registered_at']).replace(' ', 'T')}Z`);
    expect(agent?.task).toEqual({ id: 'TASK-1', title: 'Wire the web client' });
  });

  it('reads a human added without a token as token null', () => {
    expect(parseAddMemberResult(body('members-add-human')).token).toBeNull();
    expect(parseAddMemberResult(body('members-add-computational')).token).toBeTypeOf('string');
  });

  it('returns null, not a throw, for a refusal that is not in the bridge error shape', () => {
    expect(parseErrorBody('<html>502 Bad Gateway</html>')).toBeNull();
    expect(parseErrorBody({ error: 'boom' })).toBeNull();
    expect(parseErrorBody({ error: { code: 7, message: 'x' } })).toBeNull();
  });
});

describe('guards on damaged answers', () => {
  type Edit = (copy: Record<string, unknown>) => void;
  const item = (copy: Record<string, unknown>, list: string, index: number): Record<string, unknown> => {
    const element = (copy[list] as Array<Record<string, unknown>>)[index];
    if (!element) throw new Error(`the recording has no ${list}[${index}]`);
    return element;
  };
  // [what is damaged, recording, guard, the field the error must name, the damage]
  const cases: ReadonlyArray<readonly [string, string, (value: unknown) => unknown, string, Edit]> = [
    ['a message time without a zone', 'messages-flan', parseMessagesPage, 'messages[2].created_at', (c) => {
      item(c, 'messages', 2)['created_at'] = '2026-10-10 13:44:19';
    }],
    ['a fractional message id', 'messages-flan', parseMessagesPage, 'messages[0].id', (c) => {
      item(c, 'messages', 0)['id'] = 1.5;
    }],
    ['a mention that is not a string', 'messages-flan', parseMessagesPage, 'messages[2].mentions[0]', (c) => {
      item(c, 'messages', 2)['mentions'] = [42];
    }],
    ['a missing has_more', 'messages-flan', parseMessagesPage, 'has_more', (c) => {
      delete c['has_more'];
    }],
    ['a kind the badges do not know', 'me-admin', parseMe, 'kind', (c) => {
      c['kind'] = 'bot';
    }],
    ['a negative read pointer', 'repos-admin', parseRepos, 'repos[1].last_read_id', (c) => {
      item(c, 'repos', 1)['last_read_id'] = -1;
    }],
    ['an agent name that is not a string', 'directory', parseDirectory, 'agents[0]', (c) => {
      c['agents'] = [5];
    }],
    ['an unknown delivery', 'post-dm-agent', parseSendResult, 'delivery', (c) => {
      c['delivery'] = 'maybe';
    }],
    ['an unknown member status', 'members-list', parseMembers, 'members[0].status', (c) => {
      item(c, 'members', 0)['status'] = 'paused';
    }],
    ['an audit detail that is a string', 'audit', parseAudit, 'entries[1].detail', (c) => {
      item(c, 'entries', 1)['detail'] = 'x';
    }],
    ['an agent time in neither form', 'board', parseBoard, 'agents[0].last_seen_at', (c) => {
      item(c, 'agents', 0)['last_seen_at'] = 'yesterday';
    }],
    ['a token that is missing', 'members-rotate-token', parseTokenResult, 'token', (c) => {
      delete c['token'];
    }],
  ];

  it.each(cases)('refuses %s, naming the field', (_what, name, parse, field, edit) => {
    expect(refusedField(parse, damaged(name, edit))).toBe(field);
  });

  it('names the whole body when the answer is not an object', () => {
    expect(refusedField(parseMessagesPage, 'not an object')).toBe('body');
    expect(refusedField(parseMessagesPage, [])).toBe('body');
    expect(refusedField(parseMessagesPage, null)).toBe('body');
  });
});

// GET /v1/repos/{key}/conversations (SPEC section 5, V5 finding 9). No recording holds it (the recorder is
// not part of this slice), so the answers are written out here, in the shape bridge/test/conversations.test.js pins.
describe('parseConversations', () => {
  const entry = (a: string, b: string, last_id: number, last_at = '2026-10-10T14:06:56Z'): Record<string, unknown> => ({ a, b, last_id, last_at });
  const answer = (...conversations: Array<Record<string, unknown>>): Record<string, unknown> => ({ repo: 'repo-c522d9cf', conversations });

  it('reads the answer into exactly the typed fields, in the order the bridge gave them', () => {
    const read = parseConversations(answer(entry('codex', 'thom', 8), entry('grace', 'thom', 6, '2026-10-10T14:06:55Z')));
    expect(read).toEqual({
      repo: 'repo-c522d9cf',
      conversations: [
        { a: 'codex', b: 'thom', last_id: 8, last_at: '2026-10-10T14:06:56Z' },
        { a: 'grace', b: 'thom', last_id: 6, last_at: '2026-10-10T14:06:55Z' },
      ],
    });
  });

  it('reads an empty list: a repo with no direct messages, or a member with none', () => {
    expect(parseConversations(answer())).toEqual({ repo: 'repo-c522d9cf', conversations: [] });
  });

  it('ignores fields it does not know, at the top and in an entry, and returns fresh objects', () => {
    const wire: Record<string, unknown> = { ...answer({ ...entry('a', 'b', 3), text: 'a private word', epoch: 'x' }), epoch: 'e', extra: [1] };
    const read = parseConversations(wire);
    expect(Object.keys(read).sort()).toEqual(['conversations', 'repo']);
    expect(Object.keys(read.conversations[0] ?? {}).sort()).toEqual(['a', 'b', 'last_at', 'last_id']);
    expect(read.conversations[0]).not.toBe((wire['conversations'] as unknown[])[0]);
  });

  // [what is damaged, the answer, the field the error must name]
  const damage: ReadonlyArray<readonly [string, unknown, string]> = [
    ['a body that is not an object', 'not an object', 'body'],
    ['a body that is an array', [], 'body'],
    ['a missing repo', { conversations: [] }, 'repo'],
    ['a repo that is not a string', { repo: 7, conversations: [] }, 'repo'],
    ['a missing list', { repo: 'r' }, 'conversations'],
    ['a list that is not an array', { repo: 'r', conversations: {} }, 'conversations'],
    ['an entry that is not an object', answer(entry('a', 'b', 1), 'a,b' as unknown as Record<string, unknown>), 'conversations[1]'],
    ['a missing handle a', answer({ b: 'b', last_id: 1, last_at: '2026-10-10T14:06:56Z' }), 'conversations[0].a'],
    ['a handle b that is a number', answer({ ...entry('a', 'b', 1), b: 5 }), 'conversations[0].b'],
    ['a null handle', answer({ ...entry('a', 'b', 1), a: null }), 'conversations[0].a'],
    ['a missing last_id', answer({ a: 'a', b: 'b', last_at: '2026-10-10T14:06:56Z' }), 'conversations[0].last_id'],
    ['a last_id that is a string', answer({ ...entry('a', 'b', 1), last_id: '1' }), 'conversations[0].last_id'],
    ['a fractional last_id', answer({ ...entry('a', 'b', 1), last_id: 1.5 }), 'conversations[0].last_id'],
    ['a negative last_id', answer({ ...entry('a', 'b', 1), last_id: -1 }), 'conversations[0].last_id'],
    ['a missing last_at', answer({ a: 'a', b: 'b', last_id: 1 }), 'conversations[0].last_at'],
    ['a last_at without a zone', answer(entry('a', 'b', 1, '2026-10-10 14:06:56')), 'conversations[0].last_at'],
    ['a last_at that is null', answer({ ...entry('a', 'b', 1), last_at: null }), 'conversations[0].last_at'],
  ];

  it.each(damage)('refuses %s, naming the field', (_what, value, field) => {
    expect(refusedField(parseConversations, value)).toBe(field);
  });
});
