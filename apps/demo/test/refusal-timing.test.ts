import { describe, expect, it } from "vitest";
import { MIN_SAMPLES, recommendFloor, summarize } from "./refusal-timing.ts";

const repeat = (value: number, times = MIN_SAMPLES) => Array<number>(times).fill(value);

describe("refusal timing", () => {
  it("summarizes each arm by nearest-rank percentiles", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);

    const [summary] = summarize({ "bad signature": samples.reverse() });

    expect(summary).toEqual({ arm: "bad signature", n: 100, p50: 50, p95: 95, p99: 99, max: 100 });
  });

  it("orders arms slowest first by p95, not by their rarest spikes", () => {
    const spiky = [...repeat(10, 98), 1000, 1000];

    const summaries = summarize({ spiky, steady: repeat(50), fast: repeat(5) });

    expect(summaries.map((s) => s.arm)).toEqual(["steady", "spiky", "fast"]);
  });

  it("sets the floor at half again the slowest p95, rounded up to 50 ms", () => {
    expect(recommendFloor(summarize({ a: repeat(30), b: repeat(80) }))).toBe(150);
    expect(recommendFloor(summarize({ a: repeat(100) }))).toBe(150);
    expect(recommendFloor(summarize({ a: repeat(101) }))).toBe(200);
    expect(recommendFloor(summarize({ a: [...repeat(100, 95), ...repeat(5000, 5)] }))).toBe(150);
  });

  it("refuses to recommend from too few samples", () => {
    expect(() => recommendFloor(summarize({}))).toThrow();
    expect(() => summarize({ empty: [] })).toThrow();
    // Enough that a p95 has at least five samples above it.
    expect(MIN_SAMPLES).toBeGreaterThanOrEqual(100);
    const enough = repeat(10);
    expect(() => recommendFloor(summarize({ a: enough, b: enough.slice(1) }))).toThrow(`b: ${MIN_SAMPLES - 1} samples`);
  });
});
