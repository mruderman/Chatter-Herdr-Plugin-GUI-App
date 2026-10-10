import { HttpError, mentionsOf } from './util.js';

export const DEFAULT_LIMITS = { maxBody: 8000, postsPerMinute: 20 };

/**
 * Decide whether `member` may send `body` to `to` ("#chat" or a handle).
 * Pure: the caller supplies who counts as a Herdr agent and who as a member.
 * Throws HttpError on refusal; nothing is written by the caller in that case.
 *
 * Chatter itself trusts any caller outside a pane as the human, so these
 * checks are the only thing standing between a member and "@everyone".
 */
export function checkWrite({ member, to, body, agentNames, memberHandles, limits = DEFAULT_LIMITS }) {
  if (typeof to !== 'string' || !to) throw new HttpError(400, 'bad_request', '"to" must be "#chat" or a handle');
  if (typeof body !== 'string') throw new HttpError(400, 'bad_request', '"body" must be a string');
  const text = body.trim();
  if (!text) throw new HttpError(400, 'empty_body', 'message is empty');
  if (text.includes('\0')) throw new HttpError(400, 'invalid_body', 'message contains a NUL byte');
  if (text.length > limits.maxBody) {
    throw new HttpError(413, 'body_too_long', `message is longer than ${limits.maxBody} characters`);
  }
  const admin = member.role === 'admin';
  const { handles, everyone } = mentionsOf(text);

  if (to === '#chat') {
    if (everyone && !admin) {
      throw new HttpError(403, 'everyone_admin_only', '@everyone is reserved for the admin; nothing was posted');
    }
    const agents = handles.filter((h) => agentNames.has(h));
    if (agents.length && !admin && !member.can_address_agents) {
      throw new HttpError(403, 'agents_not_allowed', 'you may not address Herdr agents; nothing was posted');
    }
    return {
      mode: 'post',
      body: text,
      agentTargets: agents,
      memberTargets: handles.filter((h) => memberHandles.has(h) && h !== member.handle),
      everyone,
    };
  }

  if (to === member.handle) throw new HttpError(400, 'self_dm', 'cannot message yourself');
  const toAgent = agentNames.has(to);
  const toMember = memberHandles.has(to);
  if (!toAgent && !toMember) throw new HttpError(404, 'unknown_recipient', `no agent or member named "${to}"`);
  if (toAgent && !admin && !member.can_address_agents) {
    throw new HttpError(403, 'agents_not_allowed', 'you may not message Herdr agents');
  }
  return { mode: 'dm', body: text, to, toAgent, toMember, agentTargets: toAgent ? [to] : [], memberTargets: toMember ? [to] : [], everyone: false };
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
