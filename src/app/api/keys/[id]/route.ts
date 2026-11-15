import { NextResponse } from "next/server";
import { deleteApiKey, getApiKey, setApiKeyStatus } from "@/lib/turso";
import { maskKey } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** تعطيل / تنشيط يدوي لمفتاح */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { action?: string; status?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح — JSON مطلوب." }, { status: 400 });
  }

  const existing = await getApiKey(id);
  if (!existing) return NextResponse.json({ error: "المفتاح غير موجود." }, { status: 404 });

  const action = (body.action ?? "").toLowerCase();
  const statusWanted = (body.status ?? "").toLowerCase();

  if (action === "disable" || statusWanted === "disabled") {
    await setApiKeyStatus(id, "disabled");
  } else if (action === "enable" || statusWanted === "active") {
    // التنشيط يعيد المفتاح المستنزف إلى الخدمة أيضًا (قد يكون شحن المستخدم رصيده)
    await setApiKeyStatus(id, "active");
  } else {
    return NextResponse.json({ error: "action يجب أن يكون disable أو enable." }, { status: 400 });
  }

  const updated = await getApiKey(id);
  return NextResponse.json({ key: updated ? { id: updated.id, status: updated.status, masked: maskKey(updated.api_key) } : null });
}

/** حذف مفتاح نهائيًا */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = await getApiKey(id);
  if (!existing) return NextResponse.json({ error: "المفتاح غير موجود." }, { status: 404 });
  await deleteApiKey(id);
  return NextResponse.json({ ok: true });
}
