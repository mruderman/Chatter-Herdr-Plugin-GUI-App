// The services the running app is made of (T10 brief, "Wiring"): the Board and Admin views must use
// the very Api the store uses, so the token stays in the store's closure; and the notifier ends with
// the store. The bridge is a stub fetch answering from the recordings.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { body } from '../../test/fixtures/recorded';
import { ManualClock } from '../api/clock';
import { ROUTES } from '../api/routes';
import { createServices, type Services } from './services';

// A throwaway that opens nothing anywhere.
const TOKEN = 'test-token-services';
const REPO = 'repo-c522d9cf';

interface Sent {
  readonly url: string;
  readonly authorization: string | null;
}

/** A bridge that knows one member, has no repositories to stream, and answers the board. */
function stubBridge() {
  const sent: Sent[] = [];
  const answer = (status: number, json: unknown): Response => Response.json(json, { status });
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const authorization = new Headers(init.headers).get('authorization');
    sent.push({ url, authorization });
    if (url === ROUTES.me) return authorization === `Bearer ${TOKEN}` ? answer(200, body('me-computational')) : answer(401, body('me-unauthenticated'));
    if (url === ROUTES.directory) return answer(200, body('directory'));
    if (url === ROUTES.repos) return answer(200, { repos: [] });
    if (url === ROUTES.board(REPO)) return answer(200, body('board'));
    return answer(404, body('not-found'));
  };
  return { sent, fetch };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const made: Services[] = [];
afterEach(() => {
  for (const services of made.splice(0)) services.dispose();
  vi.restoreAllMocks();
});

function make(fetch: ReturnType<typeof stubBridge>['fetch']): Services {
  const services = createServices({ fetch, clock: new ManualClock(), notificationApi: null, storage: null });
  made.push(services);
  return services;
}

describe('createServices', () => {
  it('gives the views the store\'s own Api: it sends the token the store holds, in the header only', async () => {
    const bridge = stubBridge();
    const services = make(bridge.fetch);
    await settle();
    expect(services.store.getSnapshot().session).toEqual({ status: 'signed-out', error: null });

    expect(await services.store.signIn(TOKEN)).toBe(true);
    await services.api.board(REPO);
    const board = bridge.sent.filter((request) => request.url === ROUTES.board(REPO));
    expect(board).toEqual([{ url: ROUTES.board(REPO), authorization: `Bearer ${TOKEN}` }]);
    expect(bridge.sent.some((request) => request.url.includes(TOKEN))).toBe(false);
  });

  it('sends no token through that Api once the member has signed out', async () => {
    const bridge = stubBridge();
    const services = make(bridge.fetch);
    await settle();
    await services.store.signIn(TOKEN);
    services.store.signOut();
    await services.api.board(REPO);
    expect(bridge.sent.at(-1)).toEqual({ url: ROUTES.board(REPO), authorization: null });
  });

  it('ends the notifier and the store together', () => {
    const services = make(stubBridge().fetch);
    const notifier = vi.spyOn(services.notifier, 'dispose');
    const store = vi.spyOn(services.store, 'dispose');
    services.dispose();
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(1);
  });
});
