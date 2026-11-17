import { NextResponse } from "next/server";
import { isSessionValid, resolveSecretKey, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/status — حالة المصادقة للوحة التحكم:
 *  authenticated: هل كوكي الجلسة صالح؟
 *  configured: هل المفتاح السري مضبوط إطلاقًا؟ (اسم فقط — بلا أي قيمة)
 */
export async function GET(req: Request) {
  const secret = await resolveSecretKey();
  const cookie = req.headers.get("cookie") || "";
  const rawToken = cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(SESSION_COOKIE + "="))?.slice(SESSION_COOKIE.length + 1) ?? "";
  let token = "";
  try {
    token = decodeURIComponent(rawToken).trim();
  } catch {
    token = rawToken.trim();
  }
  let authenticated = false;
  try {
    authenticated = secret !== null && token.length > 0 && (await isSessionValid(token));
  } catch {
    authenticated = false;
  }
  return NextResponse.json(
    { authenticated, configured: secret !== null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
