import { NextResponse } from "next/server";
import { buildHealthPayload } from "@/lib/healthcheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * مسار بديل مكافئ لـ /api/health — يرجع «متصل» بمجرد نجاح الاتصال بـ Turso.
 * يبقَ للتوافق مع أي أدوات أو فحوصات تستخدم /api/status.
 */
export async function GET() {
  const payload = await buildHealthPayload();
  return NextResponse.json(payload, { status: 200 });
}
