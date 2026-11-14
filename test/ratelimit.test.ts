import { afterEach, describe, expect, it } from "vitest";
import { createFailureLimiter, type FailureLimiter } from "../src/http/ratelimit.js";

/** A limiter on a clock the test controls. */
const make = (options: { maxFailures?: number; windowMs?: number; maxEntries?: number } = {}) => {
  let time = 1_000_000;
  const limiter = createFailureLimiter({ ...options, now: () => time });
  limiters.push(limiter);
  return {
    limiter,
    advance: (ms: number): void => {
      time += ms;
    },
  };
};

const limiters: FailureLimiter[] = [];
afterEach(() => {
  for (const limiter of limiters.splice(0)) limiter.close();
});

const fail = (limiter: FailureLimiter, source: string, times: number): void => {
  for (let i = 0; i < times; i += 1) limiter.recordFailure(source);
};

describe("failure limiter: reaching the limit", () => {
  it("does not limit a source until it has failed ten times", () => {
    const { limiter } = make();
    fail(limiter, "203.0.113.7", 9);
    expect(limiter.retryAfter("203.0.113.7")).toBeUndefined();
    fail(limiter, "203.0.113.7", 1);
    expect(limiter.retryAfter("203.0.113.7")).toBeDefined();
  });

  it("reports how long until the window ends, rounded up to a whole second", () => {
    const { limiter, advance } = make();
    fail(limiter, "a", 10);
    expect(limiter.retryAfter("a")).toBe(60);
    advance(14_500);
    expect(limiter.retryAfter("a")).toBe(46);
    advance(45_000);
    expect(limiter.retryAfter("a")).toBe(1);
  });

  it("honours a different threshold and window", () => {
    const { limiter } = make({ maxFailures: 3, windowMs: 5_000 });
    fail(limiter, "a", 2);
    expect(limiter.retryAfter("a")).toBeUndefined();
    fail(limiter, "a", 1);
    expect(limiter.retryAfter("a")).toBe(5);
  });
});

describe("failure limiter: the window", () => {
  it("lets the source try again once the window has ended, with a fresh count", () => {
    const { limiter, advance } = make();
    fail(limiter, "a", 10);
    advance(59_999);
    expect(limiter.retryAfter("a")).toBeDefined();
    advance(1);
    expect(limiter.retryAfter("a")).toBeUndefined();
    fail(limiter, "a", 9);
    expect(limiter.retryAfter("a")).toBeUndefined();
  });

  it("is a fixed window anchored at the first failure, not extended by later ones", () => {
    const { limiter, advance } = make();
    fail(limiter, "a", 1);
    advance(30_000);
    fail(limiter, "a", 9);
    expect(limiter.retryAfter("a")).toBe(30);
    advance(30_000);
    expect(limiter.retryAfter("a")).toBeUndefined();
  });

  it("starts a new window for a failure that comes after the old one ended", () => {
    const { limiter, advance } = make();
    fail(limiter, "a", 9);
    advance(60_000);
    fail(limiter, "a", 9);
    expect(limiter.retryAfter("a")).toBeUndefined();
  });
});

describe("failure limiter: sources are independent and successes are free", () => {
  it("limits one source without affecting another", () => {
    const { limiter } = make();
    fail(limiter, "198.51.100.1", 10);
    expect(limiter.retryAfter("198.51.100.1")).toBeDefined();
    expect(limiter.retryAfter("198.51.100.2")).toBeUndefined();
    expect(limiter.retryAfter("2001:db8::1")).toBeUndefined();
  });

  it("never records anything for a source it is only asked about", () => {
    const { limiter } = make();
    for (let i = 0; i < 1000; i += 1) limiter.retryAfter(`10.0.${i >> 8}.${i & 255}`);
    expect(limiter.size).toBe(0);
  });
});

describe("failure limiter: a bounded store", () => {
  it("never tracks more sources than its limit, however many addresses fail", () => {
    const { limiter } = make({ maxEntries: 100 });
    for (let i = 0; i < 5000; i += 1) limiter.recordFailure(`10.1.${i >> 8}.${i & 255}`);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it("makes room by dropping expired entries before live ones", () => {
    const { limiter, advance } = make({ maxEntries: 10 });
    for (let i = 0; i < 5; i += 1) fail(limiter, `old-${i}`, 10);
    advance(60_000);
    for (let i = 0; i < 5; i += 1) fail(limiter, `live-${i}`, 10);
    fail(limiter, "newcomer", 10);
    expect(limiter.size).toBe(6);
    for (let i = 0; i < 5; i += 1) expect(limiter.retryAfter(`live-${i}`)).toBeDefined();
    expect(limiter.retryAfter("newcomer")).toBeDefined();
  });

  it("evicts the oldest live entry only when everything is live", () => {
    const { limiter } = make({ maxEntries: 3 });
    for (const source of ["a", "b", "c"]) fail(limiter, source, 10);
    fail(limiter, "d", 10);
    expect(limiter.size).toBe(3);
    expect(limiter.retryAfter("a")).toBeUndefined();
    expect(limiter.retryAfter("d")).toBeDefined();
  });

  it("sweeps expired entries on demand", () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 50; i += 1) limiter.recordFailure(`s${i}`);
    advance(60_000);
    limiter.sweep();
    expect(limiter.size).toBe(0);
  });

  it("holds at most the default 10 000 sources", () => {
    const { limiter } = make();
    for (let i = 0; i < 12_000; i += 1) limiter.recordFailure(`h${i}`);
    expect(limiter.size).toBeLessThanOrEqual(10_000);
  });
});
