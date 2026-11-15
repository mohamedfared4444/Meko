import { dbHealthy, describeDbError } from "@/lib/turso";
import { modelsSummary } from "@/lib/models";
import { mergerBase, mergerHealthy } from "@/lib/merger";

/**
 * بناء حمولة فحص الجهوزية المشتركة — يستخدمها /api/health و /api/status.
 * الحالة 200 دائمًا حتى تقرأ الواجهة الرسالة التشخيصية بدل التعامل معها كخطأ شبكة،
 * ونجاح الاتصال بـ Turso يعني ok=true أي «متصل» فورًا.
 */
export async function buildHealthPayload(): Promise<{
  ok: boolean;
  database: string;
  dbError: string | null;
  mcpEndpoint: string;
  models: ReturnType<typeof modelsSummary>;
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}> {
  let ok = false;
  try {
    ok = await dbHealthy();
  } catch {
    ok = false; // dbHealthy يبتلع الاستثناءات — لكن نحمي أيضًا ضد أي فشل غير متوقع
  }

  // سبب دقيق عند الفشل: استدعاء متعمد لالتقاط الاستثناء الأصلي برسالة واضحة
  let dbError: string | null = null;
  if (!ok) {
    try {
      const { getTurso, ensureSchema } = await import("@/lib/turso");
      await ensureSchema();
      await getTurso().execute("SELECT 1");
      dbError = "فشل استعلام قاعدة البيانات دون رسالة خطأ — أعد المحاولة.";
    } catch (e) {
      dbError = describeDbError(e);
      console.error("[health] DB detail:", dbError);
    }
  }

  const healthy = await mergerHealthy(4000); // فحص GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ
  const base = mergerBase();

  return {
    ok,
    database: ok ? "turso-connected" : "turso-disconnected",
    dbError,
    mcpEndpoint: "/mcp",
    models: modelsSummary(),
    merger: { base: base ?? "", healthy },
    authRequired: !!process.env.MCP_ACCESS_TOKEN,
  };
}
