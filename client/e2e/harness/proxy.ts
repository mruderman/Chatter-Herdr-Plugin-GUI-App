// A TCP proxy in front of the bridge that a spec can cut and restore. Chromium's offline emulation
// (context.setOffline, or CDP Network.emulateNetworkConditions) fails new requests but leaves an
// in-flight fetch stream open and delivering, so on its own it cannot make the client lose its
// stream. Resetting the proxied sockets does, and refusing new ones keeps reconnects failing.
import net from 'node:net';

export interface CuttableProxy {
  /** The proxy's own origin; load the page from here so all of its traffic goes through the proxy. */
  readonly url: string;
  /** Resets every proxied connection and refuses new ones until restore(). */
  cut(): void;
  restore(): void;
  close(): Promise<void>;
}

export async function startProxy(target: string): Promise<CuttableProxy> {
  const upstream = new URL(target);
  const live = new Set<net.Socket>();
  let open = true;

  const server = net.createServer((client) => {
    if (!open) {
      client.resetAndDestroy();
      return;
    }
    const bridge = net.connect(Number(upstream.port), upstream.hostname);
    const pair = [client, bridge];
    const drop = (): void => {
      for (const s of pair) {
        s.destroy();
        live.delete(s);
      }
    };
    for (const s of pair) {
      live.add(s);
      s.on('error', drop);
      s.on('close', drop);
    }
    client.pipe(bridge);
    bridge.pipe(client);
  });
  // Port 0: the OS picks a free port, so parallel runs never collide.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the proxy did not get a TCP port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    cut() {
      open = false;
      for (const s of [...live]) s.resetAndDestroy();
      live.clear();
    },
    restore() {
      open = true;
    },
    close: () => new Promise<void>((resolve) => {
      open = false;
      for (const s of [...live]) s.destroy();
      live.clear();
      server.close(() => resolve());
    }),
  };
}
