// How the measurement scripts wait for a fresh deploy of the measurement Worker
// before measuring. See docs/refusal-floor.md and docs/workers-free.md.

/**
 * How many answers in a row must come from the new version before measuring.
 * The edge can go on serving the previous version for a while after one
 * request reaches the new one, so one answer would let early rounds reach it.
 */
export const NEW_VERSION_ANSWERS = 8;

/**
 * Probe until the new version has answered `NEW_VERSION_ANSWERS` times in a
 * row, pausing after each answer from the previous version, which starts the
 * count again. Returns how many probes it took; throws after `attempts`.
 */
export async function awaitNewVersion(
  answersNew: () => Promise<boolean>,
  { attempts, pause }: { attempts: number; pause: () => Promise<void> },
): Promise<number> {
  let inARow = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    inARow = (await answersNew()) ? inARow + 1 : 0;
    if (inARow === NEW_VERSION_ANSWERS) return attempt;
    if (inARow === 0) await pause();
  }
  throw new Error(`the new version did not answer ${NEW_VERSION_ANSWERS} times in a row in ${attempts} attempts`);
}
