// How long REA gets to stop, and how long the whole gateway shutdown may take (spec:
// session-management, "Reliable child termination" and "Graceful shutdown").

export interface ShutdownTiming {
  /** After REA's stdin closes, how long it gets to exit before it is sent SIGTERM. */
  readonly graceMs: number;
  /** The most a gateway shutdown may take before it gives up and exits non-zero. */
  readonly budgetMs: number;
}

/**
 * With checkpointing REA may need time to save a large analysis when asked to stop, so
 * it gets 30 s and the budget is 40 s, which needs a container stop timeout to match.
 * Without it, 5 s and 10 s: the budget fits inside Docker's default stop timeout.
 */
export const shutdownTiming = (checkpointing: boolean): ShutdownTiming =>
  checkpointing ? { graceMs: 30_000, budgetMs: 40_000 } : { graceMs: 5_000, budgetMs: 10_000 };
