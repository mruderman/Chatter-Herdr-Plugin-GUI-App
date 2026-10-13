// T13b: a mention is checked as Chatter reads it (a capital letter ends the token) as well as whole,
// against the real Chatter CLI (no Herdr running, so a push to an agent is queued, never delivered).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { haveChatter, makeEnv } from './helpers.js';

const SKIP = !haveChatter && 'set CHATTER_JS to a built Chatter checkout';
const AUDIT = { push: 'push_agent', everyone: 'everyone' };
const AGENT = 'codex-worker';

describe('T13b: mentions are read as Chatter reads them', { skip: SKIP }, () => {
  let x;
  before(async () => {
    x = await makeEnv();
    x.addMember('thom', { can_address_agents: false });
    x.addMember('kai');
    x.seedAgent(AGENT);
  });
  after(async () => { await x.stop(); });

  const audits = async () => (await x.api('flan', 'GET', '/v1/audit?limit=500')).body.entries;
  const auditedFor = async (id, action) => (await audits()).filter((a) => a.message_id === id && a.action === action);

  const refusedUnwritten = async (who, body, code) => {
    const count = x.count();
    const audited = (await audits()).length;
    const r = await x.post(who, '#chat', body);
    assert.equal(r.status, 403, `${body}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, code, body);
    assert.equal(x.count(), count, `${body}: nothing was written`);
    assert.equal((await audits()).length, audited, `${body}: no push and no @everyone was audited`);
  };

  test('a member who may not address agents is refused a mention that Chatter ends at a capital letter', async () => {
    for (const body of ['hey @codex-workerZ', 'hey @codX']) await refusedUnwritten('thom', body, 'agents_not_allowed');
  });

  test('a non-admin is refused @everyone however it is written', async () => {
    for (const body of ['@everyoneX hi', '@everyone hi', '@Everyone hi']) await refusedUnwritten('kai', body, 'everyone_admin_only');
  });

  test('an admin\'s @everyone still posts, and one that Chatter ends at a capital letter is audited as one', async () => {
    for (const body of ['@everyone hi', '@everyoneX hi']) {
      const r = await x.post('flan', '#chat', body);
      assert.equal(r.status, 201, `${body}: ${JSON.stringify(r.body)}`);
      assert.equal((await auditedFor(r.body.id, AUDIT.everyone)).length, 1, `${body}: audited as @everyone`);
      const row = (await x.messages('kai', '?limit=500')).body.messages.find((m) => m.id === r.body.id);
      assert.equal(row.everyone, true, body);
    }
  });

  test('a permitted member still pushes, by the agent\'s exact name and by the name Chatter reads', async () => {
    for (const body of [`hey @${AGENT}`, 'hey @codX']) {
      const r = await x.post('kai', '#chat', body);
      assert.equal(r.status, 201, `${body}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.pushed, [`${AGENT} (queued)`], body);
      assert.equal((await auditedFor(r.body.id, AUDIT.push)).length, 1, `${body}: the push was audited`);
    }
  });
});
