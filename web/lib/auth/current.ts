import { redirect } from "next/navigation";
import { connection } from "next/server";
import { auth } from "@/auth";
import { DEV_USER, devBypassEnabled } from "./allowlist";

export interface CurrentUser {
  email: string;
  name: string | null;
  /** Signed in through DEV_AUTH_BYPASS, not Google. */
  dev: boolean;
}

/** The signed-in user, or null. With DEV_AUTH_BYPASS it's always the fixed dev user. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (devBypassEnabled()) return { email: DEV_USER.email, name: DEV_USER.name, dev: true };
  const session = await auth();
  const email = session?.user?.email;
  return email ? { email, name: session.user?.name ?? null, dev: false } : null;
}

/**
 * For pages and server actions: the signed-in user, or a redirect to /sign-in. Calling it makes a
 * page render per request (`connection()`), never at build time, even under the dev bypass, which
 * reads no cookies: every page that calls it reads the database.
 */
export async function requireUser(): Promise<CurrentUser> {
  await connection();
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return user;
}
