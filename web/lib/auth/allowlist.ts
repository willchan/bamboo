/** An env to read: `process.env` by default, a plain object in tests. */
export type Env = Readonly<Record<string, string | undefined>>;

/** `ALLOWED_EMAILS` (comma-separated, case-insensitive): the Google sign-in allowlist. */
export function isAllowedEmail(email: string | null | undefined, env: Env = process.env): boolean {
  if (!email) return false;
  const allowed = (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

/**
 * `DEV_AUTH_BYPASS=1` signs in a fixed dev user, for local dev and e2e only (DESIGN §3.1). It is
 * refused on every Vercel deployment (production and previews alike): `VERCEL` / `VERCEL_ENV` are
 * set there by the platform, so a stray env var can never open the app.
 */
export const devBypassEnabled = (env: Env = process.env): boolean =>
  env.DEV_AUTH_BYPASS === "1" && !env.VERCEL && !env.VERCEL_ENV;

/** The fixed dev user. `example.com` can't belong to a real Google account. */
export const DEV_USER = { id: "dev", email: "dev@example.com", name: "Dev" } as const;
