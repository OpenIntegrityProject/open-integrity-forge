// Uniform refusal: every refused ceremony looks the same from outside. The
// cause is kept only in the internal failure record.

export type Ceremony = "register" | "login" | "enrol" | "recover" | "step-up" | "rebind";

/** Thrown inside a ceremony to refuse it. It never leaves the library. */
export class CeremonyRefusal extends Error {
  constructor(readonly reason: string) {
    super(`ceremony refused: ${reason}`);
  }
}

export const REFUSAL_STATUS = 400;
export const REFUSAL_BODY = '{"error":"ceremony refused"}';

/** Wait until `floorMs` has passed since `startedAt`, then return the one refusal response. */
export async function uniformRefusal(startedAt: number, floorMs: number): Promise<Response> {
  const remaining = startedAt + floorMs - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  return new Response(REFUSAL_BODY, {
    status: REFUSAL_STATUS,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
