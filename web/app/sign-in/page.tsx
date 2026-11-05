import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { BambooMark } from "@/components/bamboo-mark";
import { APP_NAME, APP_TAGLINE } from "@/lib/app";
import { getCurrentUser } from "@/lib/auth/current";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  AccessDenied: "That Google account isn't allowed to use Bamboo.",
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const params = await searchParams;
  const error = one(params.error);
  const back = one(params.callbackUrl);
  // Only same-site paths.
  const redirectTo = back?.startsWith("/") && !back.startsWith("//") ? back : "/";
  if (await getCurrentUser()) redirect(redirectTo);

  return (
    <main className="flex flex-1 items-center justify-center px-5 py-10">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-2xl border border-border bg-card p-8 text-center">
        <BambooMark className="size-16 rounded-2xl" />
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">{APP_NAME}</h1>
          <p className="text-sm text-muted">{APP_TAGLINE}</p>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {ERRORS[error] ?? "Sign-in didn't work. Try again."}
          </p>
        ) : null}
        <form
          className="w-full"
          action={async () => {
            "use server";
            await signIn("google", { redirectTo });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-xl bg-primary px-4 py-3 font-medium text-primary-foreground"
          >
            Sign in with Google
          </button>
        </form>
      </div>
    </main>
  );
}
