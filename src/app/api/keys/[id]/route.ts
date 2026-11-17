import { NextResponse } from "next/server";
import { requireAccess } from "@/lib/auth";
import { deleteApiKey, describeDbError, getApiKey, setApiKeyStatus } from "@/lib/turso";
import { maskKey } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** تعطيل / تنشيط يدوي لمفتاح — محمية: جلسة لوحة أو Bearer مفتاح الأتمتة */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAccess(req);
  if (denied) return denied;
  const { id } = await params;
  let body: { action?: string; status?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح — JSON مطلوب." }, { status: 400 });
  }

  const action = (body.action ?? "").toLowerCase();
  const statusWanted = (body.status ?? "").toLowerCase();

  try {
    const existing = await getApiKey(id);
    if (!existing) return NextResponse.json({ error: "المفتاح غير موجود." }, { status: 404 });

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
  } catch (e) {
    const detail = describeDbError(e);
    console.error("[keys:PATCH]", detail);
    return NextResponse.json({ error: "فشل تغيير حالة المفتاح — خطأ قاعدة البيانات.", detail }, { status: 503 });
  }
}

/** حذف مفتاح نهائيًا — محمية: جلسة لوحة أو Bearer مفتاح الأتمتة */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAccess(req);
  if (denied) return denied;
  const { id } = await params;
  try {
    const existing = await getApiKey(id);
    if (!existing) return NextResponse.json({ error: "المفتاح غير موجود." }, { status: 404 });
    await deleteApiKey(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const detail = describeDbError(e);
    console.error("[keys:DELETE]", detail);
    return NextResponse.json({ error: "فشل حذف المفتاح — خطأ قاعدة البيانات.", detail }, { status: 503 });
  }
}
