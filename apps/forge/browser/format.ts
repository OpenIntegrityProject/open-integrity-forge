// How the stage, the history band and the sheets write hashes, keys, times and counts.

export const short = (oid: string | null | undefined) => (oid ? oid.slice(0, 7) : "");

/** `SHA256:` and the first 10 characters of the digest. */
export const shortFingerprint = (fp: string) => (fp.startsWith("SHA256:") ? `${fp.slice(0, 17)}…` : fp);

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

/** The time left as m:ss, or as h:mm:ss for an hour or more. */
export function remaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The lane colour class of an agent. The two agents of the demo have their own
 * colours, and all other agents share a third. Without an agent id, the result
 * is the class of main.
 */
export const laneClass = (agentId: string | null | undefined) =>
  agentId === "ada" ? "lane-ada" : agentId === "bo" ? "lane-bo" : agentId ? "lane-other" : "lane-main";
