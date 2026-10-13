// How the refusal timing floor is chosen from measured refusal arms. See
// docs/refusal-floor.md for the method this implements.

export interface ArmSummary {
  arm: string;
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Fewest samples per arm, so that a p95 has at least five samples above it. */
export const MIN_SAMPLES = 100;
/** The floor is this many times the slowest arm's p95... */
const FLOOR_MARGIN = 1.5;
/** ...rounded up to a multiple of this, in milliseconds. */
const FLOOR_STEP_MS = 50;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** Per-arm percentiles of wall times in milliseconds, slowest p95 first. */
export function summarize(samples: Record<string, number[]>): ArmSummary[] {
  return Object.entries(samples)
    .map(([arm, times]) => {
      if (times.length === 0) throw new Error(`no samples for ${arm}`);
      const sorted = [...times].sort((a, b) => a - b);
      return { arm, n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.at(-1)! };
    })
    .sort((a, b) => b.p95 - a.p95);
}

/**
 * The floor that covers the slowest arm's p95 with margin. Not its p99: the
 * rarest spikes come from the network and Durable Objects, not from the arm,
 * and move from arm to arm between runs.
 */
export function recommendFloor(summaries: ArmSummary[]): number {
  const slowest = summaries[0];
  if (!slowest) throw new Error("no arms measured");
  for (const s of summaries) {
    if (s.n < MIN_SAMPLES) throw new Error(`${s.arm}: ${s.n} samples, fewer than ${MIN_SAMPLES}`);
  }
  return Math.ceil((slowest.p95 * FLOOR_MARGIN) / FLOOR_STEP_MS) * FLOOR_STEP_MS;
}
