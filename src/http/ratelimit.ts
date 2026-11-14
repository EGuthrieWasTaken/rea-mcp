// Failed-authentication rate limiting (spec: api-key-auth, "Failed-authentication
// rate limiting"; design D5).
//
// An in-memory fixed-window counter per source address: a source that has failed
// `maxFailures` times within a window is refused (the caller answers 429) until
// that window ends, WITHOUT the presented key being evaluated. Only failures are
// counted; a request that succeeds never touches the limiter. The store is bounded
// and swept, so a flood of distinct source addresses cannot grow it without limit.
//
// Trade-off: when the store is full of live entries the oldest is evicted, so an
// attacker with more than `maxEntries` distinct addresses can shed their own
// blocks. That costs them thousands of addresses for ten more guesses each.

export interface FailureLimiter {
  /** Seconds until `source` may try again, or undefined if it is not limited. Never counts. */
  retryAfter(source: string): number | undefined;
  /** Count one failed attempt from `source`. */
  recordFailure(source: string): void;
  /** Drop every entry whose window has ended. */
  sweep(): void;
  /** Stop the periodic sweep. */
  close(): void;
  /** Number of sources currently tracked. */
  readonly size: number;
}

export interface FailureLimiterOptions {
  /** Failures allowed per window before the source is refused. Default 10. */
  maxFailures?: number;
  /** Window length. Default 60 s. */
  windowMs?: number;
  /** Most sources tracked at once. Default 10 000. */
  maxEntries?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

interface Entry {
  failures: number;
  /** Fixed: set by the first failure of the window, never extended. */
  windowEnds: number;
}

export function createFailureLimiter(options: FailureLimiterOptions = {}): FailureLimiter {
  const maxFailures = options.maxFailures ?? 10;
  const windowMs = options.windowMs ?? 60_000;
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? Date.now;

  // A Map iterates in insertion order, so its first key is the oldest source.
  const entries = new Map<string, Entry>();

  const sweep = (): void => {
    const current = now();
    for (const [source, entry] of entries) {
      if (current >= entry.windowEnds) entries.delete(source);
    }
  };

  // Housekeeping only: correctness never depends on it (expiry is checked on use).
  const timer = setInterval(sweep, windowMs);
  timer.unref();

  return {
    retryAfter(source) {
      const entry = entries.get(source);
      if (entry === undefined) return undefined;
      const current = now();
      if (current >= entry.windowEnds) {
        entries.delete(source);
        return undefined;
      }
      if (entry.failures < maxFailures) return undefined;
      return Math.max(1, Math.ceil((entry.windowEnds - current) / 1000));
    },

    recordFailure(source) {
      const current = now();
      const entry = entries.get(source);
      if (entry !== undefined && current < entry.windowEnds) {
        entry.failures += 1;
        return;
      }
      entries.delete(source);
      if (entries.size >= maxEntries) {
        sweep();
        if (entries.size >= maxEntries) {
          const oldest = entries.keys().next();
          if (oldest.done !== true) entries.delete(oldest.value);
        }
      }
      entries.set(source, { failures: 1, windowEnds: current + windowMs });
    },

    sweep,

    close() {
      clearInterval(timer);
    },

    get size() {
      return entries.size;
    },
  };
}
