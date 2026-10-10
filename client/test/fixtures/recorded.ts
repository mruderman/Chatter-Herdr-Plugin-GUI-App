// Typed access to the recordings that client/scripts/record-fixtures.mjs makes against a real
// bridge and real Chatter. Bodies come back as `unknown`: whoever uses one runs it through the
// guards in src/api/guards.ts first, exactly as the app does with a live answer.
import apiText from './api.json?raw';
import epochStream from './sse/epoch.sse?raw';
import liveStream from './sse/live.sse?raw';
import resumeStream from './sse/resume.sse?raw';
import revokedStream from './sse/revoked.sse?raw';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  /** Whose token was sent: a member handle, a label for a bad credential, or null for none. */
  readonly as: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly raw_body?: string;
}

export interface RecordedExchange {
  readonly request: RecordedRequest;
  readonly status: number;
  readonly content_type: string | null;
  /** The parsed JSON answer; absent for streams, whose bytes are in `file`. */
  readonly body?: unknown;
  readonly file?: string;
}

export const STREAMS = {
  live: liveStream,
  resume: resumeStream,
  revoked: revokedStream,
  epoch: epochStream,
} as const;
export type StreamName = keyof typeof STREAMS;

type Fields = Readonly<Record<string, unknown>>;

function fields(value: unknown, what: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`fixtures: ${what} is not an object`);
  // Checked just above.
  return value as Fields;
}

const document = fields(JSON.parse(apiText), 'api.json');
const exchanges = fields(document['exchanges'], 'exchanges');

/** Every recorded exchange name, in recording order. */
export const EXCHANGE_NAMES: readonly string[] = Object.keys(exchanges);

export function exchange(name: string): RecordedExchange {
  const entry = fields(exchanges[name], `exchange "${name}"`);
  const request = fields(entry['request'], `exchange "${name}" request`);
  const status = entry['status'];
  if (typeof status !== 'number' || typeof request['method'] !== 'string' || typeof request['path'] !== 'string') {
    throw new Error(`fixtures: exchange "${name}" is malformed`);
  }
  // The shape was written by record-fixtures.mjs and its required fields are checked above.
  return entry as unknown as RecordedExchange;
}

/** The recorded JSON answer of an exchange. */
export function body(name: string): unknown {
  const entry = exchange(name);
  if (!('body' in entry)) throw new Error(`fixtures: exchange "${name}" has no JSON body`);
  return entry.body;
}

/** The recorded `{error:{code,message}}` of a refused exchange. */
export function recordedError(name: string): { readonly status: number; readonly code: string; readonly message: string } {
  const entry = exchange(name);
  const error = fields(fields(entry.body, `exchange "${name}" body`)['error'], `exchange "${name}" error`);
  const code = error['code'];
  const message = error['message'];
  if (typeof code !== 'string' || typeof message !== 'string') throw new Error(`fixtures: exchange "${name}" has no error`);
  return { status: entry.status, code, message };
}

/** The raw bytes of a recorded event stream, exactly as the bridge sent them. */
export function streamBytes(name: StreamName): Uint8Array {
  return new TextEncoder().encode(STREAMS[name]);
}
