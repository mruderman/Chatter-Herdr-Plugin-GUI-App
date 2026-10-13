import { HttpError, mentionsOf } from './util.js';

export const DEFAULT_LIMITS = { maxBody: 8000, postsPerMinute: 20 };
const AMBIGUOUS_RECIPIENT = 'ambiguous_recipient';
const AGENTS_UNVERIFIABLE = 'agents_unverifiable';
/** Whether Herdr said which agents are live (`ChatterHost.liveAgents`): `ok`, or `unknown` when it could not be read. */
export const LIVE_STATUS = Object.freeze({ ok: 'ok', unknown: 'unknown' });
const UNVERIFIABLE_MENTION = 'The bridge cannot tell right now which Herdr agents are live, and you may not address Herdr agents, so a message that mentions anyone cannot be checked; nothing was posted. Post it without the @mention, or try again shortly.';
const UNVERIFIABLE_DM = 'The bridge cannot tell right now which Herdr agents are live, and you may not address Herdr agents, so it cannot check that this direct message reaches no agent; nothing was sent. Try again shortly.';

/**
 * Decide whether `member` may send `body` to `to` ("#chat" or a handle).
 * Pure: the caller supplies who counts as a Herdr agent (`agentNames`: every repo, live or departed),
 * the target repo's roster of non-departed agents (`repoAgents`), the live agents Herdr reports
 * (`liveAgents`: `{ names, status }`) and who counts as a member.
 * Throws HttpError on refusal; nothing is written by the caller in that case.
 *
 * Chatter itself trusts any caller outside a pane as the human, so these
 * checks are the only thing standing between a member and "@everyone".
 */
export function checkWrite({ member, to, body, agentNames, repoAgents, liveAgents, memberHandles, limits = DEFAULT_LIMITS }) {
  // Required, not defaulted: a caller that forgot the roster would switch the prefix rule below off.
  if (!Array.isArray(repoAgents)) throw new TypeError('checkWrite needs the repo roster (repoAgents)');
  // Required too: a caller that forgot the live agents would let a member who may not address agents reach one.
  if (!liveAgents || !Array.isArray(liveAgents.names) || !Object.values(LIVE_STATUS).includes(liveAgents.status)) {
    throw new TypeError('checkWrite needs the live Herdr agents (liveAgents: { names, status })');
  }
  if (typeof to !== 'string' || !to) throw new HttpError(400, 'bad_request', '"to" must be "#chat" or a handle');
  if (typeof body !== 'string') throw new HttpError(400, 'bad_request', '"body" must be a string');
  const text = body.trim();
  if (!text) throw new HttpError(400, 'empty_body', 'message is empty');
  if (text.includes('\0')) throw new HttpError(400, 'invalid_body', 'message contains a NUL byte');
  if (text.length > limits.maxBody) {
    throw new HttpError(413, 'body_too_long', `message is longer than ${limits.maxBody} characters`);
  }
  const admin = member.role === 'admin';
  const restricted = !admin && !member.can_address_agents;
  // Herdr did not say which agents are live, so any name could reach one this check cannot see. Chatter, too,
  // sees none then, so only a member who may not address agents is held back, and only when naming someone.
  const unverifiable = restricted && liveAgents.status !== LIVE_STATUS.ok;
  const { handles, everyone } = mentionsOf(text);
  // Chatter's `resolveRecipient` (behind both `send` and the mentions of `post`) takes its candidates from the
  // repo's roster and from the live named agents Herdr reports in the repo (`teamAgents`), registered or
  // not. Every live name of the session counts here, in this repo or another: the bridge cannot cheaply tell
  // which repo a pane works in, so it over-approximates, failing closed.
  const knownAgents = new Set([...agentNames, ...liveAgents.names]);
  const roster = [...new Set([...repoAgents, ...liveAgents.names])];
  // Chatter takes a name it does not know exactly as the one candidate that it is the start of
  // (case-insensitively), so such a name reaches that agent. Every name that is the start of a roster name
  // counts as that agent here, even where Chatter would find several and pick none: fail closed.
  const agentsStartingWith = (h) => roster.filter((n) => n.toLowerCase().startsWith(h.toLowerCase()));
  const agentLike = (h) => knownAgents.has(h) || agentsStartingWith(h).length > 0;

  if (to === '#chat') {
    if (everyone && !admin) {
      throw new HttpError(403, 'everyone_admin_only', '@everyone is reserved for the admin; nothing was posted');
    }
    const agents = handles.filter(agentLike);
    if (agents.length && restricted) {
      const byPrefix = agents.find((h) => !knownAgents.has(h));
      throw new HttpError(403, 'agents_not_allowed', byPrefix
        ? `@${byPrefix} is the start of the name of the Herdr agent ${agentsStartingWith(byPrefix).join(', ')}, and Chatter could deliver it there; you may not address Herdr agents, so nothing was posted`
        : 'you may not address Herdr agents; nothing was posted');
    }
    if (unverifiable && handles.length) throw new HttpError(503, AGENTS_UNVERIFIABLE, UNVERIFIABLE_MENTION);
    return {
      mode: 'post',
      body: text,
      memberTargets: handles.filter((h) => memberHandles.has(h) && h !== member.handle),
      everyone,
    };
  }

  if (to === member.handle) throw new HttpError(400, 'self_dm', 'cannot message yourself');
  const toAgent = knownAgents.has(to);
  const toMember = memberHandles.has(to);
  if (!toAgent && !toMember) throw new HttpError(404, 'unknown_recipient', `no agent or member named "${to}"`);
  // A private message must reach the one it names, never an agent Chatter resolves the name to instead, nor
  // its sender, so admins are refused too. Chatter resolves it against this repo's roster and the live agents
  // whose cwd is in this repo, while `agentNames` spans every repo and departed agents, and Herdr's list the
  // whole session: an agent's name counts as itself only if Chatter is sure to find it exactly, and otherwise,
  // like a member's handle, it must not be the start of a name that is a candidate.
  const started = agentsStartingWith(to);
  const exactlyIn = (names) => names.some((n) => n.toLowerCase() === to.toLowerCase());
  // On this repo's registered roster, Chatter matches it before any prefix. A name only Herdr's list offers
  // may belong to another repo, which Chatter leaves out here; then it would take the name for one that begins
  // with it, so such a name counts as itself only when nothing else begins with it.
  const onRoster = toAgent && (exactlyIn(repoAgents) || (exactlyIn(liveAgents.names) && started.length === 1));
  if (started.length && !onRoster) {
    const advice = toAgent ? `"${to}" is not a live agent of this repo.` : 'An admin can rename the member or the agent.';
    throw new HttpError(409, AMBIGUOUS_RECIPIENT, `"${to}" is the start of the name of the Herdr agent ${started.join(', ')}, so Chatter could deliver this message to the agent instead; nothing was sent. ${advice}`);
  }
  // Chatter also counts the sender's own name for any name it does not know exactly, so it would take this
  // one for the sender: a member's handle, or an agent name only the directory offers. Only an exact name of
  // the roster is matched before that.
  if (!onRoster && member.handle.toLowerCase().startsWith(to.toLowerCase())) {
    const advice = toAgent ? `"${to}" is not a live agent of this repo.` : `${to} can still message you, or an admin can rename one of you.`;
    throw new HttpError(409, AMBIGUOUS_RECIPIENT, `"${to}" is the start of your own handle, so Chatter would take it for you; nothing was sent. ${advice}`);
  }
  if (toAgent && restricted) {
    throw new HttpError(403, 'agents_not_allowed', 'you may not message Herdr agents');
  }
  // Last: a refusal known for certain says what it is; this one only asks to try again.
  if (unverifiable) throw new HttpError(503, AGENTS_UNVERIFIABLE, UNVERIFIABLE_DM);
  return { mode: 'dm', body: text, to, toAgent, toMember, memberTargets: toMember ? [to] : [], everyone: false };
}

/** Token bucket per member for writes. */
export class RateLimiter {
  constructor(perMinute, now = () => Date.now()) {
    this.perMinute = perMinute;
    this.now = now;
    this.buckets = new Map();
  }

  take(handle) {
    const t = this.now();
    const b = this.buckets.get(handle) || { tokens: this.perMinute, at: t };
    b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    if (b.tokens < 1) {
      this.buckets.set(handle, b);
      throw new HttpError(429, 'rate_limited', `limit is ${this.perMinute} messages per minute`);
    }
    b.tokens -= 1;
    this.buckets.set(handle, b);
  }
}
