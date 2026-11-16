import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { describeDbError, findDuplicateKey, insertApiKey, listApiKeys } from "@/lib/turso";
import { maskKey } from "@/lib/errors";
import type { ProviderId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** المزودات المدعومة في مدير المفاتيح */
const SUPPORTED_PROVIDERS: string[] = ["kie", "cometapi", "cloudflare", "pollinations", "gemini", "huggingface"];

/** تطبيع مفتاح Hugging Face — بادئة hf_ تُوحَّد صغيرة عند التخزين */
function normalizeHuggingFaceKey(key: string): string {
  return key.replace(/^hf_/i, "hf_");
}

/** عرض المفاتيح كاملة الترتيب — مقنّعة دائمًا، لا يُعاد المفتاح الكامل في أي استجابة */
export async function GET() {
  try {
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
  } catch (e) {
    const detail = describeDbError(e);
    console.error("[keys:GET]", detail);
    return NextResponse.json({ error: "فشل قراءة المفاتيح من قاعدة البيانات.", detail }, { status: 503 });
  }
}

/** إضافة مفتاح — مع رفض التكرار لنفس المزود والتحقق من صيغة مفاتيح Cloudflare */
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

  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return NextResponse.json(
      { error: `المزود غير مدعوم — القيم المقبولة: ${SUPPORTED_PROVIDERS.join(" أو ")}.` },
      { status: 400 },
    );
  }

  // مفتاح Cloudflare بصيغتين: ACCOUNT_ID:API_TOKEN أو ACCOUNT_ID:EMAIL:GLOBAL_API_KEY — يُفصلان عند نقطتين ويُطهَّران
  let normalizedKey = apiKey;
  if (provider === "cloudflare") {
    const parts = apiKey.split(":").map((p) => p.trim()).filter((p) => p.length > 0);
    const valid2 = parts.length === 2 && parts[0].length >= 4 && parts[1].length >= 4;
    const valid3 =
      parts.length === 3 &&
      parts[0].length >= 4 &&
      parts[1].includes("@") &&
      parts[1].length >= 6 &&
      parts[2].length >= 4;
    if (!valid2 && !valid3) {
      return NextResponse.json(
        {
          error:
            "مفتاح Cloudflare يجب أن يكون بصيغة ACCOUNT_ID:API_TOKEN (توكن Bearer) أو ACCOUNT_ID:EMAIL:GLOBAL_API_KEY (مفتاح API العام) — مفصولة بنقطتين، والبريد يجب أن يحتوي @.",
        },
        { status: 400 },
      );
    }
    normalizedKey = parts.join(":");
  }

  // مفتاح Gemini: يُقبل كما هو بلا أي رفض للبادئات — مفاتيح Google AI Studio
  // (تبدأ AIza) ومفاتيح Google Cloud الجديدة (تبدأ AQ.) كلها صالحة، وأي مفتاح
  // آخر بطول كافٍ يُقبل أيضًا (Google قد تضيف صيغًا جديدة لاحقًا).
  if (provider === "gemini" && normalizedKey.length < 8) {
    return NextResponse.json(
      { error: "مفتاح Google Gemini مطلوب (8 أحرف على الأقل) — مفاتيح AI Studio بصيغة AIza… ومفاتيح Cloud بصيغة AQ.… كلاهما مقبول." },
      { status: 400 },
    );
  }

  // مفتاح Hugging Face: تُطبَّع البادئة Hf_/HF_ إلى hf_ صغيرة عند التخزين
  if (provider === "huggingface") {
    normalizedKey = normalizeHuggingFaceKey(apiKey);
    if (normalizedKey.length < 8) {
      return NextResponse.json(
        { error: "مفتاح Hugging Face مطلوب (8 أحرف على الأقل) — بصيغة hf_… وتُطبَّع البادئة تلقائيًا من Hf_ إلى hf_." },
        { status: 400 },
      );
    }
  }

  // Pollinations مجاني بلا مفتاح حقيقي — يقبل أي نص تعريفي مثل «free»
  if (provider === "pollinations") {
    if (!apiKey) {
      return NextResponse.json(
        { error: "أدخل أي نص تعريفي في حقل المفتاح مثل free — مزود Pollinations مجاني ولا يتطلب مفتاحًا حقيقيًا." },
        { status: 400 },
      );
    }
  } else if (apiKey.length < 8) {
    return NextResponse.json({ error: "المفتاح مطلوب (8 أحرف على الأقل)." }, { status: 400 });
  }

  try {
    const dup = await findDuplicateKey(provider, normalizedKey);
    if (dup) {
      return NextResponse.json(
        { error: `هذا المفتاح مضاف مسبقًا لنفس المزود (${maskKey(normalizedKey)}).` },
        { status: 409 },
      );
    }

    const created = await insertApiKey({ id: randomUUID(), provider, label, api_key: normalizedKey });
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
  } catch (e) {
    const detail = describeDbError(e);
    console.error("[keys:POST]", detail);
    return NextResponse.json({ error: "تعذر حفظ المفتاح — فشل الاتصال بقاعدة بيانات Turso.", detail }, { status: 503 });
  }
}
