import { NextResponse } from "next/server";
import { dbHealthy, describeDbError } from "@/lib/turso";
import { modelsSummary } from "@/lib/models";
import { mergerBase, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** فحص الجهوزية: قاعدة البيانات + الموديلات + خدمة الدمج + حالة التوثيق */
export async function GET() {
  let ok = false;
  let dbError: string | null = null;
  try {
    ok = await dbHealthy();
    if (!ok) dbError = "فشل استعلام قاعدة البيانات (SELECT 1) — السبب أدناه في dbDetail إن وُجد.";
  } catch (e) {
    ok = false;
    dbError = describeDbError(e);
    console.error("[health] DB unhealthy:", dbError);
  }

  // سبب أكثر دقة: أعد استدعاءً متعمدًا لالتقاط رسالة الخطأ الفعلية من العميل
  let dbDetail: string | null = null;
  if (!ok) {
    try {
      // إعادة استدعاء متعمدة لالتقاط الاستثناء الأصلي (dbHealthy يبتلعه)
      const { getTurso, ensureSchema } = await import("@/lib/turso");
      await ensureSchema();
      await getTurso().execute("SELECT 1");
      dbDetail = dbError;
    } catch (e) {
      dbDetail = describeDbError(e);
      console.error("[health] DB detail:", dbDetail);
    }
  }

  const healthy = await mergerHealthy(4000); // فحص GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ
  const base = mergerBase();

  return NextResponse.json(
    {
      ok,
      database: ok ? "turso-connected" : "turso-disconnected",
      dbError: ok ? null : (dbDetail ?? dbError),
      mcpEndpoint: "/mcp",
      models: modelsSummary(),
      merger: { base: base ?? "", healthy },
      authRequired: !!process.env.MCP_ACCESS_TOKEN,
    },
    // 200 دائمًا حتى تقرأ الواجهة الرسالة التشخيصية بدل التعامل معها كخطأ شبكة
    { status: 200 },
  );
}
