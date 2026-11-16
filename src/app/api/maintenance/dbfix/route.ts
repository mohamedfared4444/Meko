import { NextResponse } from "next/server";
import { postReport, runDbfix } from "@/lib/maintenance";

/**
 * نقطة صيانة مؤقتة (تُحذف بعد التنفيذ) — cron فقط:
 * إدراج مفاتيح gemini/huggingface في Turso الحية + تفعيل مفاتيح cloudflare
 * + اختبار Gemini حي + تقرير إلى webhook.site.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const host = req.headers.get("host") ?? "";
  // يُستدعى من Vercel Cron (ترويسة داخلية) أو بسر النداء — أغلق الوصول العام
  const secret = new URL(req.url).searchParams.get("key");
  const isCron = req.headers.get("x-vercel-cron") !== null;
  if (!isCron && secret !== "0f4c1e7a93b24d6e8a51c7f2b39d6408") {
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
