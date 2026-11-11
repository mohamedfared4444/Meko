import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { modelsSummary } from "@/lib/models";
import { mergerBase, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** فحص الجهوزية: قاعدة البيانات + الموديلات + خدمة الدمج + حالة التوثيق */
export async function GET() {
  const ok = await dbHealthy();
  const healthy = await mergerHealthy(4000); // فحص GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ
  const base = mergerBase();

  return NextResponse.json(
    {
      ok,
      database: ok ? "turso-connected" : "turso-disconnected",
      mcpEndpoint: "/mcp",
      models: modelsSummary(),
      merger: { base: base ?? "", healthy },
      authRequired: !!process.env.MCP_ACCESS_TOKEN,
    },
    { status: ok ? 200 : 503 },
  );
}
