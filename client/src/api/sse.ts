// An incremental parser for text/event-stream, following the WHATWG "event stream interpretation"
// rules. Bytes may be split anywhere by the network: inside a line, between CR and LF, or inside
// a multi-byte character. The decoder and the line buffer carry the pieces across chunks.

export interface SseEvent {
  /** The `event:` field, or `message` when there was none. */
  readonly type: string;
  /** The `data:` lines joined with LF. */
  readonly data: string;
  /** The last `id:` seen on the stream so far, not only in this event; empty if none yet. */
  readonly lastEventId: string;
}

export interface SseHandlers {
  onEvent(event: SseEvent): void;
  /** A `retry:` field with a valid number of milliseconds. */
  onRetry?(ms: number): void;
}

const LF = 0x0a;
const CR = 0x0d;
const DEFAULT_TYPE = 'message';
const RETRY_VALUE = /^\d+$/;

export class SseParser {
  // Without `stream: true` mid-stream a split character would decode as U+FFFD. The default
  // ignoreBOM: false strips one leading byte-order mark, as the format requires.
  private readonly decoder = new TextDecoder('utf-8');
  private readonly handlers: SseHandlers;
  private line = '';
  // The previous chunk ended in CR: an LF at the start of the next one ends the same line.
  private afterCr = false;
  private type = '';
  private data = '';
  private idBuffer = '';
  private ended = false;

  constructor(handlers: SseHandlers) {
    this.handlers = handlers;
  }

  get lastEventId(): string {
    return this.idBuffer;
  }

  push(chunk: Uint8Array): void {
    if (this.ended) return;
    this.consume(this.decoder.decode(chunk, { stream: true }));
  }

  /** The stream is over. A last event without its closing blank line is discarded, as the format requires. */
  end(): void {
    if (this.ended) return;
    this.consume(this.decoder.decode());
    this.ended = true;
    this.line = '';
    this.type = '';
    this.data = '';
  }

  private consume(text: string): void {
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (this.afterCr) {
        this.afterCr = false;
        if (code === LF) {
          start = i + 1;
          continue;
        }
      }
      if (code === CR || code === LF) {
        this.line += text.slice(start, i);
        const line = this.line;
        this.line = '';
        this.afterCr = code === CR;
        start = i + 1;
        this.field(line);
        // A handler may have ended the parser (the caller closed the stream from inside onEvent).
        if (this.ended) return;
      }
    }
    this.line += text.slice(start);
  }

  private field(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (name) {
      case 'event':
        this.type = value;
        break;
      case 'data':
        this.data += `${value}\n`;
        break;
      case 'id':
        if (!value.includes('\0')) this.idBuffer = value;
        break;
      case 'retry':
        if (RETRY_VALUE.test(value)) this.handlers.onRetry?.(Number(value));
        break;
      default:
        break;
    }
  }

  private dispatch(): void {
    if (this.data === '') {
      this.type = '';
      return;
    }
    const event: SseEvent = {
      type: this.type || DEFAULT_TYPE,
      data: this.data.endsWith('\n') ? this.data.slice(0, -1) : this.data,
      lastEventId: this.idBuffer,
    };
    this.type = '';
    this.data = '';
    this.handlers.onEvent(event);
  }

  /** Stops the parser from inside a handler: nothing after the current event is delivered. */
  stop(): void {
    this.ended = true;
  }
}
