import { NextResponse } from "next/server";
import { buildHealthPayload } from "@/lib/healthcheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** فحص الجهوزية: قاعدة البيانات + الموديلات + خدمة الدمج + حالة التوثيق */
export async function GET() {
  const payload = await buildHealthPayload();
  return NextResponse.json(payload, { status: 200 });
}
