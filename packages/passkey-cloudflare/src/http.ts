// Session transport: the `__Host-session` cookie for browsers, or an equivalent
// `Authorization: Bearer` header for other clients.

export const SESSION_COOKIE = "__Host-session";

export function sessionValueFrom(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
  const cookie = request.headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}

/**
 * The cookie carrying a session that lasts `lifetimeMs`. Apps reach it through
 * `passkeys.sessionCookie`, which passes the configured lifetime.
 */
export function sessionCookie(value: string, lifetimeMs: number): string {
  return `${SESSION_COOKIE}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${lifetimeMs / 1000}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
