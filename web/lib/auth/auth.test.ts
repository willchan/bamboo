import { describe, expect, it } from "vitest";
import { authConfig, SESSION_MAX_AGE_SECONDS } from "@/auth";
import { devBypassEnabled, type Env, isAllowedEmail } from "./allowlist";

const WILL = "learner@example.com";

describe("isAllowedEmail", () => {
  const env = { ALLOWED_EMAILS: ` ${WILL.toUpperCase()} , other@example.org ` };

  it("matches case- and whitespace-insensitively", () => {
    expect(isAllowedEmail(WILL, env)).toBe(true);
    expect(isAllowedEmail(" Other@Example.org", env)).toBe(true);
  });

  it("refuses everyone else, and everyone when the list is empty or unset", () => {
    expect(isAllowedEmail("stranger@example.com", env)).toBe(false);
    expect(isAllowedEmail(null, env)).toBe(false);
    expect(isAllowedEmail(WILL, { ALLOWED_EMAILS: "" })).toBe(false);
    expect(isAllowedEmail(WILL, {})).toBe(false);
  });
});

describe("devBypassEnabled", () => {
  it("is on only with DEV_AUTH_BYPASS=1", () => {
    expect(devBypassEnabled({ DEV_AUTH_BYPASS: "1" })).toBe(true);
    expect(devBypassEnabled({ DEV_AUTH_BYPASS: "true" })).toBe(false);
    expect(devBypassEnabled({})).toBe(false);
  });

  it("is refused on every Vercel deployment", () => {
    for (const VERCEL_ENV of ["production", "preview", "development"]) {
      expect(devBypassEnabled({ DEV_AUTH_BYPASS: "1", VERCEL: "1", VERCEL_ENV })).toBe(false);
      expect(devBypassEnabled({ DEV_AUTH_BYPASS: "1", VERCEL_ENV })).toBe(false);
    }
    expect(devBypassEnabled({ DEV_AUTH_BYPASS: "1", VERCEL: "1" })).toBe(false);
  });
});

describe("authConfig", () => {
  type SignIn = NonNullable<NonNullable<ReturnType<typeof authConfig>["callbacks"]>["signIn"]>;
  const signInWith = (env: Env, email: string, verified: boolean) =>
    (authConfig(env).callbacks?.signIn as SignIn)({
      user: { email },
      account: { provider: "google", type: "oidc", providerAccountId: "1" },
      profile: { email, email_verified: verified },
    } as Parameters<SignIn>[0]);

  const env = { ALLOWED_EMAILS: WILL, AUTH_SECRET: "s" };

  it("signs in an allowed, verified Google account", async () => {
    expect(await signInWith(env, WILL, true)).toBe(true);
  });

  it("refuses any other account, and an unverified address", async () => {
    expect(await signInWith(env, "stranger@example.com", true)).toBe(false);
    expect(await signInWith(env, WILL, false)).toBe(false);
  });

  it("uses 90-day JWT sessions", () => {
    const { session } = authConfig(env);
    expect(session).toEqual({ strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS });
    expect(SESSION_MAX_AGE_SECONDS).toBe(90 * 24 * 60 * 60);
  });

  it("falls back to a dev secret only under DEV_AUTH_BYPASS off Vercel", () => {
    expect(authConfig({}).secret).toBeUndefined();
    expect(authConfig({ DEV_AUTH_BYPASS: "1" }).secret).toEqual(expect.any(String));
    expect(authConfig({ DEV_AUTH_BYPASS: "1", VERCEL_ENV: "production" }).secret).toBeUndefined();
    expect(authConfig({ DEV_AUTH_BYPASS: "1", AUTH_SECRET: "real" }).secret).toBe("real");
  });
});
