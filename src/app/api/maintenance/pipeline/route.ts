import { NextResponse } from "next/server";
import { postReport, runPipeline } from "@/lib/maintenance";

/**
 * نقطة صيانة مؤقتة (تُحذف بعد التنفيذ) — cron فقط:
 * تشغيل/استكمال خط إنتاج create_full_video حقيقي كامل على Vercel
 * (سكربت Gemini → صوت Edge-TTS → صور → دمج meko-manger) + تقرير خارجي.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = new URL(req.url).searchParams.get("key");
  const isCron = req.headers.get("x-vercel-cron") !== null;
  if (!isCron && secret !== "0f4c1e7a93b24d6e8a51c7f2b39d6408") {
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
