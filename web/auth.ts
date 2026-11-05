// Auth.js v5 (DESIGN §3.1): Google sign-in, JWT sessions (90 days, so the home-screen PWA rarely
// signs out), `ALLOWED_EMAILS` allowlist. `DEV_AUTH_BYPASS` is handled in lib/auth/current.ts and
// proxy.ts; it never adds a provider here.
import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { devBypassEnabled, type Env, isAllowedEmail } from "@/lib/auth/allowlist";

export const SESSION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

// Only used when DEV_AUTH_BYPASS is on and AUTH_SECRET is unset, so `pnpm dev` works with no
// .env.local at all. devBypassEnabled() is false on Vercel, so this can never sign a real session.
const DEV_ONLY_SECRET = "bamboo-dev-auth-bypass-not-a-secret";

export function authConfig(env: Env = process.env): NextAuthConfig {
  return {
    providers: [Google],
    secret: env.AUTH_SECRET || (devBypassEnabled(env) ? DEV_ONLY_SECRET : undefined),
    session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
    pages: { signIn: "/sign-in", error: "/sign-in" },
    callbacks: {
      // A refused Google account lands on /sign-in?error=AccessDenied. Google must also have
      // verified the address.
      signIn: ({ user, account, profile }) =>
        isAllowedEmail(user.email, env) &&
        (account?.provider !== "google" || profile?.email_verified === true),
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig());
