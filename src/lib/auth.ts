import { NextResponse } from "next/server";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { getMeta, setMeta, deleteMeta, listMetaByPrefix } from "./turso";
/**
 * مصادقة موحدة لكل النقاط الحساسة (المفاتيح، المهام، بوابة الأتمتة):
 *
 *  - المفتاح السري واحد: env AUTOMATION_API_KEY أولًا ثم meta.automation_key في
 *    Turso (نفس مصدر بوابة الأتمتة) — بلا أي كشف للقيمة في الاستجابات أو السجلات.
 *  - مقارنة ثابتة الزمن (timingSafeEqual) بعد فحص طول متساوٍ.
 *  - الخدمات الداخلية المصرح لها (n8n لاحقًا أو أي مستهلك Bearer) تمر بترويسة
 *    Authorization: Bearer <المفتاح>.
 *  - لوحة التحكم تمر بجلسة كوكي HttpOnly (SameSite=Strict) تُنشأ عند الدخول
 *    بكلمة المرور = نفس المفتاح السري، وتُخزَّن في Turso meta (dash_session:*)
 *    لصلاحية 7 أيام — لا توكن في كود الواجهة ولا في Local/Session Storage ولا
 *    أي NEXT_PUBLIC.
 */

/**
 * ⚠️ مفتاح تجاوز الحماية — الحماية مؤقتًا متوقفة بطلب صاحب المشروع (2026-11-18).
 *  الداش بورد ونقاط المهام والمفاتيح وبوابة الأتمتة مفتوحة بلا كلمة مرور.
 *  لإعادة تفعيل الحماية: اقلب القيمة إلى false وسيستأنف كل شيء عمله فورًا
 *  (بوابة checkAccess، بوابة /api/automate/video، بوابة /api/auth/status) —
 *  نفس السطر يتحكم في الثلاثة.
 */
export const AUTH_DISABLED = true;

/** اسم كوكي الجلسة */
export const SESSION_COOKIE = "meko_session";
/** صلاحية الجلسة: 7 أيام */
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
/** بادئة مفاتيح الجلسات في جدول meta */
const SESSION_PREFIX = "dash_session:";
/** سقف الجلسات النشطة — الأقدم انتهاءً يُحذف عند تجاوزه */
const MAX_SESSIONS = 25;

// ---------------------------------------------------------------------------
// المفتاح السري والمقارنة الآمنة

/** مفتاح البوابة — env أولًا ثم meta.automation_key في Turso (بلا أي كشف للقيمة) */
export async function resolveSecretKey(): Promise<string | null> {
  const fromEnv = (process.env.AUTOMATION_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const stored = await getMeta("automation_key");
    return stored ? stored.trim() || null : null;
  } catch {
    return null;
  }
}

/** مقارنة ثابتة الزمن — لا يكشف خطأ التوقيت عن طول المفتاح الصحيح */
export function secretMatch(provided: string, secret: string): boolean {
  if (!provided || !secret || provided.length !== secret.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(secret, "utf8"));
  } catch {
    return false;
  }
}

export function bearerOf(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

function cookieTokenOf(req: Request): string {
  const cookie = req.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("=")).trim();
  }
  return "";
}

// ---------------------------------------------------------------------------
// الجلسات — مخزنة في Turso meta (dash_session:<token> → expiry ISO)

/** إنشاء جلسة جديدة وتخزينها — يعيد التوكن العشوائي (64 خانة hex) */
export async function createSession(): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await setMeta(SESSION_PREFIX + token, expires);

  // تنظيف الجلسات المنتهية + فرض السقف (الأقدم انتهاءً أولًا)
  try {
    const sessions = await listMetaByPrefix(SESSION_PREFIX);
    const parsed = sessions
      .map((s) => ({ key: s.key, exp: Date.parse(s.value) || 0 }))
      .sort((a, b) => a.exp - b.exp);
    const now = Date.now();
    const expired = parsed.filter((s) => s.exp <= now);
    for (const s of expired.slice(0, 50)) await deleteMeta(s.key).catch(() => {});
    const alive = parsed.filter((s) => s.exp > now);
    for (const s of alive.slice(0, Math.max(0, alive.length - MAX_SESSIONS))) {
      await deleteMeta(s.key).catch(() => {});
    }
  } catch {
    /* التنظيف best-effort — لا يفشل الدخول */
  }
  return token;
}

/** هل توكن الجلسة صالح؟ — الحذف تلقائي عند الانتهاء */
export async function isSessionValid(token: string): Promise<boolean> {
  if (!token || token.length !== 64 || !/^[0-9a-f]{64}$/.test(token)) return false;
  let expires: string | null = null;
  try {
    expires = await getMeta(SESSION_PREFIX + token);
  } catch {
    return false;
  }
  if (!expires) return false;
  const exp = Date.parse(expires);
  if (!Number.isFinite(exp) || exp <= Date.now()) {
    await deleteMeta(SESSION_PREFIX + token).catch(() => {});
    return false;
  }
  return true;
}

/** إلغاء جلسة (خروج) */
export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  await deleteMeta(SESSION_PREFIX + token).catch(() => {});
}

// ---------------------------------------------------------------------------
// حارس موحد للنقاط الحساسة

export type AuthCheck = { ok: true } | { ok: false; response: NextResponse };

/**
 * فحص المصادقة لأي نقطة حساسة: يقبل ترويسة Bearer بالمفتاح السري
 * (للخدمات الداخلية) أو كوكي جلسة صالحة (للوحة التحكم).
 * عند عدم ضبط أي مفتاح سري إطلاقًا تعيد 503 كي لا يُفتح المسار بالخطأ.
 */
export async function checkAccess(req: Request): Promise<AuthCheck> {
  // تجاوز الحماية — بطلب صاحب المشروع (راجع AUTH_DISABLED فوق)
  if (AUTH_DISABLED) return { ok: true };
  const secret = await resolveSecretKey();
  if (!secret) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "المصادقة غير مهيأة — اضبط AUTOMATION_API_KEY في بيئة Vercel أو خزّن meta.automation_key أولًا." },
        { status: 503 },
      ),
    };
  }
  if (secretMatch(bearerOf(req), secret)) return { ok: true };
  if (await isSessionValid(cookieTokenOf(req))) return { ok: true };
  return {
    ok: false,
    response: NextResponse.json(
      { error: "غير مصرح — سجّل الدخول من لوحة التحكم أو مرر الترويسة Authorization: Bearer <API_KEY>." },
      { status: 401 },
    ),
  };
}

/** اختصار للنقاط: يعيد استجابة الرفض أو null عند السماح */
export async function requireAccess(req: Request): Promise<NextResponse | null> {
  const check = await checkAccess(req);
  return check.ok ? null : check.response;
}

// ---------------------------------------------------------------------------
// حدّ محاولات الدخول — مخزن في Turso meta كي يعمل عبر كل نسخ serverless
// (ذاكرة النسخة الواحدة غير كافية: طلبات متتالية قد تهبط على نسخ مختلفة)

const MAX_FAILED_LOGINS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAIL_PREFIX = "login_fail:";

interface FailEntry { count: number; resetAt: number }

async function readFailEntry(ip: string): Promise<FailEntry | null> {
  try {
    const raw = await getMeta(LOGIN_FAIL_PREFIX + ip);
    if (!raw) return null;
    const j = JSON.parse(raw) as FailEntry;
    if (!j || typeof j.count !== "number" || typeof j.resetAt !== "number") return null;
    return j;
  } catch {
    return null;
  }
}

export async function loginRateLimited(ip: string): Promise<boolean> {
  const e = await readFailEntry(ip);
  if (!e) return false;
  if (e.resetAt <= Date.now()) {
    await deleteMeta(LOGIN_FAIL_PREFIX + ip).catch(() => {});
    return false;
  }
  return e.count >= MAX_FAILED_LOGINS;
}

export async function recordFailedLogin(ip: string): Promise<void> {
  const now = Date.now();
  const e = await readFailEntry(ip);
  if (!e || e.resetAt <= now) {
    await setMeta(LOGIN_FAIL_PREFIX + ip, JSON.stringify({ count: 1, resetAt: now + LOGIN_WINDOW_MS } as FailEntry)).catch(() => {});
    return;
  }
  await setMeta(LOGIN_FAIL_PREFIX + ip, JSON.stringify({ count: e.count + 1, resetAt: e.resetAt } as FailEntry)).catch(() => {});
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0]?.trim() || "unknown";
}
