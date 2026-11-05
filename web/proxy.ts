// Sign-in gate for the UI (Next 16 "proxy", formerly middleware): no session → /sign-in. API
// routes authenticate themselves (bearer tokens, DESIGN §3.1) and answer 401 instead. Pages also
// call requireUser(), so this is the first of two checks, not the only one.
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { devBypassEnabled } from "@/lib/auth/allowlist";

const gate = auth((req) => {
  if (req.auth?.user?.email) return NextResponse.next();
  const url = new URL("/sign-in", req.nextUrl);
  const back = req.nextUrl.pathname + req.nextUrl.search;
  if (back !== "/") url.searchParams.set("callbackUrl", back);
  return NextResponse.redirect(url);
});

export default function proxy(req: NextRequest, event: NextFetchEvent) {
  if (devBypassEnabled()) return NextResponse.next();
  return gate(req, event as never);
}

export const config = {
  matcher: [
    "/((?!api/|_next/|sign-in|favicon\\.ico|icon|apple-icon|manifest\\.webmanifest|robots\\.txt).*)",
  ],
};
