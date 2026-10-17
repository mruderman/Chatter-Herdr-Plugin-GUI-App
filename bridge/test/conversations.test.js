// T19a: GET /v1/repos/{key}/conversations lists the direct-message pairs a member may see (V5 finding 9),
// against the real Chatter CLI (no Herdr running, so a DM to an agent is queued, never delivered).
// The route must reveal nothing that paging /messages back would not: every expectation below is exact.
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { haveChatter, makeEnv } from './helpers.js';

const SKIP = !haveChatter && 'set CHATTER_JS to a built Chatter checkout';
const AGENT = 'codex-worker';
const CHANNEL = '#chat';
const ERR = { badToken: 'bad_token' };
// Long enough for a real Chatter run; a race test whose pause is never reached fails instead of hanging.
const RACE_TIMEOUT = { timeout: 15_000 };
// The handles below are chosen so that none can occur inside a repo key (a name plus eight hex digits):
// each has a letter outside a-f, so a whole-body "contains" check cannot pass or fail by accident.

const conversationsOf = (x, who, key = x.key) => x.api(who, 'GET', `/v1/repos/${key}/conversations`);
const messagesOf = (x, who, key = x.key) => x.api(who, 'GET', `/v1/repos/${key}/messages`);

/** Rows of Chatter's database, read-only, as a fixture check (the bridge never writes there). */
function chatterRows(x, sql, ...params) {
  const db = new DatabaseSync(path.join(x.repoInfo.dir, 'chatter.db'), { readOnly: true });
  // node:sqlite rows have a null prototype; plain objects compare with deepEqual.
  try { return db.prepare(sql).all(...params).map((r) => ({ ...r })); } finally { db.close(); }
}

/** Every message `who` can read, by paging /messages back from the newest, `limit` at a time. */
async function pageAllBack(x, who, limit) {
  const all = [];
  let beforeId = null;
  for (;;) {
    const q = `?limit=${limit}${beforeId === null ? '' : `&before_id=${beforeId}`}`;
    const r = await x.messages(who, q);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    all.unshift(...r.body.messages);
    if (!r.body.has_more || !r.body.messages.length) return all;
    beforeId = r.body.messages[0].id;
  }
}

/** The pairs a member could derive from the messages they can read: the route must answer exactly this. */
function pairsFrom(messages) {
  const byPair = new Map();
  for (const m of messages) {
    if (m.to === CHANNEL) continue;
    const [a, b] = [m.from, m.to].sort();
    const k = `${a}\u0000${b}`;
    const seen = byPair.get(k);
    if (!seen || m.id > seen.last_id) byPair.set(k, { a, b, last_id: m.id, last_at: m.created_at });
  }
  return [...byPair.values()].sort((p, q) => q.last_id - p.last_id);
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

/** Holds the next call of `obj[name]` until `release()`; `wasEntered()` says whether it was reached. */
function pauseNext(obj, name) {
  const entered = deferred();
  const gate = deferred();
  const real = obj[name];
  let reached = false;
  obj[name] = function paused(...args) {
    obj[name] = real;
    reached = true;
    entered.resolve();
    return gate.promise.then(() => real.apply(this, args));
  };
  return { entered: entered.promise, wasEntered: () => reached, release: () => gate.resolve() };
}

describe('T19a: the conversation list shows only the pairs a member may see', { skip: SKIP }, () => {
  let x;
  const id = {};
  const body = {
    thomToKai: 'thom to kai, plain',
    kaiToThom: `kai to thom, and see @${AGENT}`,
    flanToKai: 'flan to kai',
    graceToFlan: 'grace to flan',
    kaiToAgent: 'kai to the agent directly',
    kaiInChannel: `kai in the channel, @${AGENT} have a look`,
  };
  let at; // message id -> created_at as /messages shapes it, read as the admin
  let mentionCopy; // the per-recipient copy Chatter wrote for kai's channel mention

  before(async () => {
    x = await makeEnv();
    x.addMember('kai');
    x.addMember('thom');
    x.addMember('grace');
    x.seedAgent(AGENT);
    const send = async (who, to, text) => {
      const r = await x.post(who, to, text);
      assert.equal(r.status, 201, `${who} to ${to}: ${JSON.stringify(r.body)}`);
      assert.equal(typeof r.body.id, 'number', `${who} to ${to}: the row was found`);
      return r.body.id;
    };
    // thom and kai write in both directions (kai's is the newer); kai only receives from flan and only
    // sends to the agent; grace's one pair involves neither thom nor kai.
    id.thomToKai = await send('thom', 'kai', body.thomToKai);
    id.kaiToThom = await send('kai', 'thom', body.kaiToThom);
    id.flanToKai = await send('flan', 'kai', body.flanToKai);
    id.graceToFlan = await send('grace', 'flan', body.graceToFlan);
    id.kaiToAgent = await send('kai', AGENT, body.kaiToAgent);
    // Last, so that the mention copy it makes is the newest row of the kai and agent pair.
    id.kaiInChannel = await send('kai', CHANNEL, body.kaiInChannel);
    const page = await x.messages('flan', '?limit=500');
    assert.equal(page.status, 200);
    at = new Map(page.body.messages.map((m) => [m.id, m.created_at]));
    [mentionCopy] = chatterRows(x, "SELECT id, from_agent, to_agent FROM messages WHERE kind = 'mention'");
  });
  after(async () => { await x.stop(); });

  const entry = (a, b, lastId) => ({ a, b, last_id: lastId, last_at: at.get(lastId) });
  const expected = () => ({
    kai: [entry(AGENT, 'kai', id.kaiToAgent), entry('flan', 'kai', id.flanToKai), entry('kai', 'thom', id.kaiToThom)],
    thom: [entry('kai', 'thom', id.kaiToThom)],
    grace: [entry('flan', 'grace', id.graceToFlan)],
    flan: [
      entry(AGENT, 'kai', id.kaiToAgent), entry('flan', 'grace', id.graceToFlan),
      entry('flan', 'kai', id.flanToKai), entry('kai', 'thom', id.kaiToThom),
    ],
  });

  test('the fixture holds what the tests rely on: one mention copy, newer than kai\'s DM to the agent', () => {
    assert.ok(mentionCopy, 'Chatter wrote a per-recipient copy for the channel mention');
    assert.equal(mentionCopy.from_agent, 'kai');
    assert.equal(mentionCopy.to_agent, AGENT);
    assert.ok(mentionCopy.id > id.kaiToAgent, 'the copy is newer than every DM of its pair');
    for (const k of Object.keys(id)) assert.ok(at.has(id[k]), `${k} is visible to the admin`);
  });

  test('a member sees exactly the pairs they are in, newest first', async () => {
    for (const who of ['kai', 'thom', 'grace']) {
      const r = await conversationsOf(x, who);
      assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, { repo: x.key, conversations: expected()[who] }, who);
    }
  });

  test('a third member gets nothing of someone else\'s pair: neither handle is anywhere in the answer', async () => {
    const r = await conversationsOf(x, 'grace');
    assert.equal(r.status, 200);
    const text = JSON.stringify(r.body);
    for (const handle of ['thom', 'kai', AGENT]) assert.equal(text.includes(handle), false, `grace's answer names ${handle}: ${text}`);
  });

  test('an admin sees every pair', async () => {
    const r = await conversationsOf(x, 'flan');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { repo: x.key, conversations: expected().flan });
  });

  test('a mention copy never makes an entry and is never a last_id; a DM that mentions someone is one entry', async () => {
    // Chatter's send path does not read mentions: the DM whose body names the agent is one row.
    assert.equal(chatterRows(x, 'SELECT id FROM messages WHERE body = ?', body.kaiToThom).length, 1);
    const copies = new Set(chatterRows(x, "SELECT id FROM messages WHERE kind = 'mention'").map((r) => r.id));
    assert.ok(copies.size >= 1);
    for (const who of ['kai', 'flan']) {
      const r = await conversationsOf(x, who);
      assert.equal(r.status, 200);
      for (const c of r.body.conversations) assert.equal(copies.has(c.last_id), false, `${who}: ${c.a}/${c.b} ends at a mention copy`);
      const withAgent = r.body.conversations.filter((c) => c.a === AGENT || c.b === AGENT);
      assert.deepEqual(withAgent, [entry(AGENT, 'kai', id.kaiToAgent)], `${who}: one entry for kai and the agent, ending at the DM`);
      const kaiThom = r.body.conversations.filter((c) => c.a === 'kai' && c.b === 'thom');
      assert.equal(kaiThom.length, 1, `${who}: the DM that mentions the agent is one entry`);
    }
  });

  test('a pair written in both directions is one entry, ending at the newer of the two', async () => {
    assert.ok(id.kaiToThom > id.thomToKai);
    for (const who of ['kai', 'thom', 'flan']) {
      const r = await conversationsOf(x, who);
      const pair = r.body.conversations.filter((c) => [c.a, c.b].sort().join() === 'kai,thom');
      assert.deepEqual(pair, [entry('kai', 'thom', id.kaiToThom)], who);
    }
  });

  test('an answer carries only repo and, per entry, a, b, last_id and last_at: never message text', async () => {
    for (const who of ['kai', 'thom', 'grace', 'flan']) {
      const r = await conversationsOf(x, who);
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.body).sort(), ['conversations', 'repo'], who);
      for (const c of r.body.conversations) assert.deepEqual(Object.keys(c).sort(), ['a', 'b', 'last_at', 'last_id'], who);
      const text = JSON.stringify(r.body);
      for (const b of Object.values(body)) assert.equal(text.includes(b), false, `${who}: no message text (${b})`);
    }
  });

  test('each member sees exactly the pairs they could derive by paging /messages back to the start', async () => {
    for (const who of ['kai', 'thom', 'grace', 'flan']) {
      const derived = pairsFrom(await pageAllBack(x, who, 2));
      const r = await conversationsOf(x, who);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.conversations, derived, who);
    }
  });
});

describe('T19a: a repository with no direct messages', { skip: SKIP }, () => {
  let x;
  before(async () => {
    x = await makeEnv();
    x.addMember('kai');
    x.seedAgent(AGENT);
    const r = await x.post('kai', CHANNEL, `only the channel, @${AGENT}`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
  after(async () => { await x.stop(); });

  test('answers an empty list to a member and to the admin, though Chatter wrote a mention copy', async () => {
    const copies = chatterRows(x, "SELECT from_agent, to_agent FROM messages WHERE kind = 'mention'");
    assert.deepEqual(copies, [{ from_agent: 'kai', to_agent: AGENT }], 'the fixture has a non-channel row for a pair with no DM');
    for (const who of ['kai', 'flan']) {
      const r = await conversationsOf(x, who);
      assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, { repo: x.key, conversations: [] }, who);
    }
  });
});

describe('T19a: refusals are the ones /messages gives', { skip: SKIP }, () => {
  let x;
  let zedPair;
  before(async () => {
    x = await makeEnv();
    x.addMember('zed');
    const r = await x.post('zed', 'flan', 'zed to flan');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    zedPair = r.body.id;
  });
  after(async () => { await x.stop(); });

  /** Both routes answer `who` on `key` byte for byte alike, with this status and code. */
  const refusedAlike = async (who, key, status, code) => {
    const m = await messagesOf(x, who, key);
    const c = await conversationsOf(x, who, key);
    assert.equal(m.status, status, `/messages: ${JSON.stringify(m.body)}`);
    assert.equal(m.body.error.code, code);
    assert.deepEqual({ status: c.status, body: c.body }, { status: m.status, body: m.body });
    return c;
  };

  test('no credential and a bad token: 401, as /messages; a valid token next to it is answered', async () => {
    const ok = await conversationsOf(x, 'flan');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.conversations.length, 1);
    await refusedAlike(null, x.key, 401, 'unauthenticated');
    await refusedAlike('cb_wrong', x.key, 401, ERR.badToken);
  });

  test('a revoked member: answered before, 401 as /messages after, and nothing of their pair', async () => {
    const ok = await conversationsOf(x, 'zed');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.conversations.map((c) => [c.a, c.b, c.last_id]), [['flan', 'zed', zedPair]]);
    assert.equal((await x.api('flan', 'DELETE', '/v1/members/zed')).status, 200);
    const c = await refusedAlike('zed', x.key, 401, ERR.badToken);
    assert.equal(JSON.stringify(c.body).includes('flan'), false);
  });

  test('an invalid and an unknown repository key: 400 bad_repo and 404 no_such_repo, as /messages', async () => {
    await refusedAlike('flan', 'not*a*key', 400, 'bad_repo');
    await refusedAlike('flan', 'repo-00000000', 404, 'no_such_repo');
  });

  test('Chatter failing to list the repositories: the fixed 502 text, as /messages, and no host path', async () => {
    const run = x.host.run;
    x.host.run = function failing(o) {
      if (o.args[0] === 'data') return Promise.resolve({ code: 1, stdout: '', stderr: `Error: boom in ${x.root}\n    at main` });
      return run.call(this, o);
    };
    try {
      // A key the host has not cached sends it back to Chatter for a fresh list.
      const c = await refusedAlike('flan', 'repo-11111111', 502, 'chatter_error');
      assert.equal(JSON.stringify(c.body).includes(x.root), false, 'no host path in the answer');
    } finally { x.host.run = run; }
  });
});

describe('T19a: the member is read again once the repository is looked up', { skip: SKIP }, () => {
  test('a member revoked while the repo is looked up gets 401 and nothing of their pair', RACE_TIMEOUT, async () => {
    const x = await makeEnv();
    try {
      x.addMember('thom');
      x.addMember('grace');
      assert.equal((await x.post('thom', 'grace', 'thom to grace')).status, 201);
      const pause = pauseNext(x.host, 'repo');
      const reading = conversationsOf(x, 'thom');
      await Promise.race([pause.entered, reading]);
      assert.ok(pause.wasEntered(), 'the route looks the repository up');
      assert.equal((await x.api('flan', 'DELETE', '/v1/members/thom')).status, 200);
      pause.release();
      const r = await reading;
      assert.equal(r.status, 401, JSON.stringify(r.body));
      assert.equal(r.body.error.code, ERR.badToken);
      assert.equal(JSON.stringify(r.body).includes('grace'), false);
    } finally { await x.stop(); }
  });

  test('an admin demoted while the repo is looked up gets no pair between two other members', RACE_TIMEOUT, async () => {
    const x = await makeEnv();
    try {
      x.addMember('liv', { role: 'admin' });
      x.addMember('thom');
      x.addMember('grace');
      assert.equal((await x.post('thom', 'grace', 'thom to grace')).status, 201);
      const before = await conversationsOf(x, 'liv');
      assert.equal(before.body.conversations.length, 1, 'as an admin, liv sees the pair');
      const pause = pauseNext(x.host, 'repo');
      const reading = conversationsOf(x, 'liv');
      await Promise.race([pause.entered, reading]);
      assert.ok(pause.wasEntered(), 'the route looks the repository up');
      assert.equal((await x.api('flan', 'PATCH', '/v1/members/liv', { role: 'member' })).status, 200);
      pause.release();
      const r = await reading;
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body, { repo: x.key, conversations: [] });
    } finally { await x.stop(); }
  });
});
