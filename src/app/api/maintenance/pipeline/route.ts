import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { postReport, runPipeline } from "@/lib/maintenance";

/**
 * نقطة صيانة مؤقتة (تُحذف بعد التنفيذ) — cron فقط:
 * تشغيل/استكمال خط إنتاج create_full_video حقيقي كامل على Vercel
 * (سكربت Gemini → صوت Edge-TTS → صور → دمج meko-manger) + تقرير خارجي.
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
  const secret = new URL(req.url).searchParams.get("key");
  const isCron = req.headers.get("x-vercel-cron") !== null;
  if (!isCron && !maintenanceKeyOk(secret)) {
    return new NextResponse("Not Found", { status: 404 });
  }
  try {
    return NextResponse.json({ ok: true, report: await runPipeline() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await postReport("error:pipeline", { error: msg.slice(0, 500) });
    return NextResponse.json({ ok: false, error: msg.slice(0, 500) }, { status: 500 });
  }
}
