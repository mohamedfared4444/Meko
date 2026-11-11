import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { findDuplicateKey, insertApiKey, listApiKeys } from "@/lib/turso";
import { maskKey } from "@/lib/errors";
import type { ProviderId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** عرض المفاتيح كاملة الترتيب — مقنّعة دائمًا، لا يُعاد المفتاح الكامل في أي استجابة */
export async function GET() {
  const keys = await listApiKeys();
  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      masked: maskKey(k.api_key),
      status: k.status,
      usage_count: k.usage_count,
      success_count: k.success_count,
      fail_count: k.fail_count,
      last_used_at: k.last_used_at,
      last_checked_at: k.last_checked_at,
      last_error: k.last_error,
      created_at: k.created_at,
    })),
  });
}

/** إضافة مفتاح — مع رفض التكرار لنفس المزود */
export async function POST(req: Request) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح — JSON مطلوب." }, { status: 400 });
  }

  const provider = (body.provider ?? "").toLowerCase() as ProviderId;
  const apiKey = (body.api_key ?? "").trim();
  const label = (body.label ?? "").trim().slice(0, 100);

  if (provider !== "kie" && provider !== "cometapi") {
    return NextResponse.json({ error: "المزود غير مدعوم — القيم المقبولة: kie أو cometapi." }, { status: 400 });
  }
  if (!apiKey || apiKey.length < 8) {
    return NextResponse.json({ error: "المفتاح مطلوب (8 أحرف على الأقل)." }, { status: 400 });
  }

  const dup = await findDuplicateKey(provider, apiKey);
  if (dup) {
    return NextResponse.json(
      { error: `هذا المفتاح مضاف مسبقًا لنفس المزود (${maskKey(apiKey)}).` },
      { status: 409 },
    );
  }

  const created = await insertApiKey({ id: randomUUID(), provider, label, api_key: apiKey });
  return NextResponse.json(
    {
      key: {
        id: created.id,
        provider: created.provider,
        label: created.label,
        masked: maskKey(created.api_key),
        status: created.status,
      },
    },
    { status: 201 },
  );
}
