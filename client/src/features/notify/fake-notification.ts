// A stand-in for the browser's Notification, for tests (and the throwaway browser demo): it records
// what the page constructs and what it asks for, and lets a test decide how the permission prompt
// is answered. Not part of the app; index.ts does not export it.
import type { NotificationApi, NotificationHandle } from './notifier';

export class FakeNotification implements NotificationHandle {
  onclick: ((event: Event) => unknown) | null = null;
  closed = false;

  constructor(
    readonly title: string,
    readonly options: NotificationOptions | undefined,
  ) {}

  close(): void {
    this.closed = true;
  }

  /** The person clicking it, as the browser would dispatch it. */
  click(): void {
    this.onclick?.(new Event('click'));
  }
}

export interface FakeNotifications {
  /** What goes to `createNotifier({ notificationApi })`. */
  readonly api: NotificationApi;
  /** Every notification constructed, oldest first. */
  readonly shown: readonly FakeNotification[];
  /** How many times the page asked for permission. */
  readonly requests: number;
  /** What the next prompt is answered with. Default: granted. */
  answerWith(permission: NotificationPermission): void;
  /** Keeps the next prompt open until `release` is called, as a prompt waiting for the person does. */
  holdPrompt(): void;
  release(): void;
  /** The next prompt fails: `reject` as a rejected promise, `throw` as an exception from the call itself. */
  failPrompt(how: 'reject' | 'throw'): void;
  /** The permission changing outside the page, as in the browser's site settings. */
  setPermission(permission: NotificationPermission): void;
  /** Constructing a notification throws (until called with false), as it does in Chrome on Android. */
  failToConstruct(fail?: boolean): void;
}

export function createFakeNotifications(initial: NotificationPermission = 'default'): FakeNotifications {
  let permission = initial;
  let answer: NotificationPermission = 'granted';
  let requests = 0;
  let holding = false;
  let failure: 'reject' | 'throw' | null = null;
  let constructing = true;
  const waiting: Array<() => void> = [];
  const shown: FakeNotification[] = [];

  class Api extends FakeNotification {
    static get permission(): NotificationPermission {
      return permission;
    }

    static requestPermission(): Promise<NotificationPermission> {
      requests += 1;
      const how = failure;
      failure = null;
      if (how === 'throw') throw new Error('requestPermission: not allowed here');
      if (how === 'reject') return Promise.reject(new Error('requestPermission: rejected'));
      return new Promise((resolve) => {
        // A real prompt changes the permission before its promise settles; one already decided does not change.
        const settle = (): void => {
          if (permission === 'default') permission = answer;
          resolve(permission);
        };
        if (holding) waiting.push(settle);
        else settle();
      });
    }

    constructor(title: string, options?: NotificationOptions) {
      if (!constructing) throw new TypeError("Failed to construct 'Notification': Illegal constructor.");
      super(title, options);
      shown.push(this);
    }
  }

  return {
    api: Api,
    shown,
    get requests() {
      return requests;
    },
    answerWith(next) {
      answer = next;
    },
    holdPrompt() {
      holding = true;
    },
    release() {
      holding = false;
      for (const settle of waiting.splice(0)) settle();
    },
    failPrompt(how) {
      failure = how;
    },
    setPermission(next) {
      permission = next;
    },
    failToConstruct(fail = true) {
      constructing = !fail;
    },
  };
}
