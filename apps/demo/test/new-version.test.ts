import { describe, expect, it } from "vitest";
import { awaitNewVersion, NEW_VERSION_ANSWERS } from "./new-version.ts";

/** A probe that answers from the new version as `answers` says, one per call, and counts the pauses between. */
function probe(answers: boolean[]) {
  const calls = { probes: 0, pauses: 0 };
  return {
    calls,
    answersNew: async () => answers[calls.probes++] ?? true,
    pause: async () => void calls.pauses++,
  };
}

describe("waiting for a new version", () => {
  it("returns once the new version has answered 8 times in a row", async () => {
    const fake = probe(Array(NEW_VERSION_ANSWERS).fill(true));

    expect(await awaitNewVersion(fake.answersNew, { attempts: 300, pause: fake.pause })).toBe(NEW_VERSION_ANSWERS);
    expect(fake.calls).toEqual({ probes: NEW_VERSION_ANSWERS, pauses: 0 });
  });

  it("starts the count again when the previous version answers, pausing after it", async () => {
    const fake = probe([false, true, true, false, ...Array(NEW_VERSION_ANSWERS).fill(true)]);

    expect(await awaitNewVersion(fake.answersNew, { attempts: 300, pause: fake.pause })).toBe(4 + NEW_VERSION_ANSWERS);
    expect(fake.calls.pauses).toBe(2);
  });

  it("fails after the given number of attempts", async () => {
    const fake = probe(Array(50).fill(false));

    await expect(awaitNewVersion(fake.answersNew, { attempts: 20, pause: fake.pause })).rejects.toThrow(/20 attempts/);
    expect(fake.calls.probes).toBe(20);
  });

  it("succeeds on the last allowed attempt", async () => {
    const fake = probe([false, false, ...Array(NEW_VERSION_ANSWERS).fill(true)]);

    expect(await awaitNewVersion(fake.answersNew, { attempts: 2 + NEW_VERSION_ANSWERS, pause: fake.pause })).toBe(
      2 + NEW_VERSION_ANSWERS,
    );
  });
});
