/**
 * Whether this isolate has logged a request with no source address. A
 * deployment that has none has none for every request, so one error per
 * isolate names the misconfiguration without flooding the log. It lives apart
 * from the ceremonies so that `passkey-cloudflare/testing` can export it, for
 * a test to reset.
 */
export const missingSourceWarning = { logged: false };
