import { NextResponse, type NextRequest } from "next/server";

/**
 * Auth guard (only active when JOURNAL_PASSWORD is set). The session cookie is
 * validated for presence here and cryptographically in API handlers — the
 * middleware runtime has no Node crypto, so it gates navigation while the
 * handlers gate data.
 */
export const middleware = (request: NextRequest) => {
  if (process.env.JOURNAL_HOSTED_ONLY === "1") {
    const path=request.nextUrl.pathname;
    if(path.startsWith("/branding/") || path.startsWith("/workspace") || (path.startsWith("/api/hosted/") || path.startsWith("/api/oauth/google/"))) return NextResponse.next();
    if(path.startsWith("/api/")) return NextResponse.json({error:"This endpoint is not available in hosted mode"},{status:404});
    return NextResponse.redirect(new URL("/workspace",request.url));
  }
  if (!process.env.JOURNAL_PASSWORD) return NextResponse.next();
  const { pathname } = request.nextUrl;
  if (pathname === "/login" || pathname === "/api/auth") return NextResponse.next();
  const cookie = request.cookies.get("journal_session")?.value;
  if (!cookie) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
};

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
