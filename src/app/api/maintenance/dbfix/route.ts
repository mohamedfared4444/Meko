import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { postReport, runDbfix } from "@/lib/maintenance";

/**
 * نقطة صيانة مؤقتة (تُحذف بعد التنفيذ) — cron فقط:
 * إدراج مفاتيح gemini/huggingface في Turso الحية + تفعيل مفاتيح cloudflare
 * + اختبار Gemini حي + تقرير إلى webhook.site.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** سر النداء اليدوي من env MAINTENANCE_KEY — لا يُكتب في الكود (السر القديم كان متتبعًا في Git فأُزيل) */
function maintenanceKeyOk(secret: string | null): boolean {
  const expected = (process.env.MAINTENANCE_KEY || "").trim();
  if (!expected || !secret || secret.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(secret, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  const host = req.headers.get("host") ?? "";
  // يُستدعى من Vercel Cron (ترويسة داخلية) أو بسر النداء من env — أغلق الوصول العام
  const secret = new URL(req.url).searchParams.get("key");
  const isCron = req.headers.get("x-vercel-cron") !== null;
  if (!isCron && !maintenanceKeyOk(secret)) {
    return new NextResponse("Not Found", { status: 404 });
  }
  try {
    return NextResponse.json({ ok: true, report: await runDbfix() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await postReport("error:dbfix", { error: msg.slice(0, 500) });
    return NextResponse.json({ ok: false, error: msg.slice(0, 500) }, { status: 500 });
  }
}
