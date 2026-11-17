import { NextResponse } from "next/server";
import { SESSION_COOKIE, revokeSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/logout — إلغاء الجلسة الحالية ومسح الكوكي */
export async function POST(req: Request) {
  const cookie = req.headers.get("cookie") || "";
  const rawToken = cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(SESSION_COOKIE + "="))?.slice(SESSION_COOKIE.length + 1) ?? "";
  if (rawToken) {
    try {
      await revokeSession(decodeURIComponent(rawToken).trim());
    } catch {
      /* الخروج لا يفشل أبدًا */
    }
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("meko_session", "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return res;
}
