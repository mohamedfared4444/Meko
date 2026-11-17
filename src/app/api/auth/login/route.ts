import { NextResponse } from "next/server";
import { clientIp, createSession, loginRateLimited, recordFailedLogin, resolveSecretKey, secretMatch } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/login — دخول لوحة التحكم:
 * { password: "…" } — نفس مفتاح الأتمتة (env AUTOMATION_API_KEY أو meta.automation_key).
 * عند النجاح يُضبط كوكي HttpOnly + Secure + SameSite=Strict صالح 7 أيام.
 * لا تُعاد أي قيمة سرية في الاستجابة، ولا تُسجَّل في أي مكان.
 */

const COOKIE_MAX_AGE = 7 * 24 * 3600;

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (await loginRateLimited(ip)) {
    return NextResponse.json(
      { error: "محاولات دخول فاشلة كثيرة — حاول مجددًا بعد ربع ساعة." },
      { status: 429 },
    );
  }

  let body: { password?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح — JSON مطلوب." }, { status: 400 });
  }
  const password = typeof body.password === "string" ? body.password.slice(0, 200) : "";
  if (!password) {
    return NextResponse.json({ error: "كلمة المرور (password) مطلوبة." }, { status: 400 });
  }

  const secret = await resolveSecretKey();
  if (!secret) {
    return NextResponse.json(
      { error: "المصادقة غير مهيأة — اضبط AUTOMATION_API_KEY في بيئة Vercel أو خزّن meta.automation_key أولًا." },
      { status: 503 },
    );
  }
  if (!secretMatch(password, secret)) {
    await recordFailedLogin(ip);
    // رسالة عامة فقط — لا تكشف أي تفاصيل عن المفتاح أو طوله
    return NextResponse.json({ error: "كلمة المرور غير صحيحة." }, { status: 401 });
  }

  const token = await createSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set("meko_session", token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return res;
}
