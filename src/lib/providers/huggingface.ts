import { uploadViaHosts } from "../upload";
import { ProviderHttpError, type ProviderAdapter } from "./types-adapter";

/**
 * مزود Hugging Face — خط إضافي لتوليد الصور عبر Inference Providers
 * بنموذج black-forest-labs/FLUX.1-schnell (سريع وبجودة ممتازة).
 *
 * المفتاح: مفاتيح HF تُطبَّع بادئتها تلقائيًا عند الإرسال —
 *   key.replace(/^hf_/i, "hf_") — أي «Hf_…» أو «HF_…» تُرسل ببادئة hf_ صغيرة
 *   (فاليّد HF لحالة الأحرف)، والمفتاح السليم hf_… يمر كما هو.
 *
 * النداء عبر العميل الرسمي @huggingface/inference (TextToImageTask) مع مزود
 * تلقائي «auto» — يحسم المزود المضيف للموديل (hf-inference أو fal-ai أو
 * nebius) ويعيد Blob الصورة مباشرة، متجاوزًا تنويعات مسارات REST المتغيرة.
 *
 * الاستجابة تقبل شكلين (يُفحص magic bytes كضمانة):
 *  - Blob صورة ثنائية خام (الشكل الافتراضي لمهمة text-to-image)
 *  - JSON يحتوي صورة Base64 إن أعادها المزود
 *
 * الصورة الناتجة تُرفع عبر سلسلة الرفع الموثوقة المشتركة
 * (tmpfiles.org → uguu.se → litterbox → catbox → 0x0.st → data URL) ولا
 * تُلقي السلسلة خطأ أبدًا فلا يُعطَّل مفتاح صالح بسبب فشل رفع خارجي.
 * خطأ «402 Purchase pre-paid credits» يُصنَّف exhausted (رصيد) فينتقل
 * التوليد تلقائيًا للمفتاح/المزود التالي.
 */

const FLUX_MODEL_DEFAULT = "black-forest-labs/FLUX.1-schnell";

/** ميزانية العملية المتزامنة كلها (توليد + رفع) — أقل من حد Vercel 60 ثانية بهامش آمن.
 *  سلسلة الرفع تشترك مع التوليد في الميزانية المتبقية عبر remainingMs — لو نفدت
 *  تتجاوز كل المضيفين فورًا ويُعاد data URL لحظيًا فلا تُقتل دالة Vercel قبل
 *  تحديث المهمة في Turso ولا يُرمى خطأ «تعذر رفع الصورة» أبدًا. */
const SYNC_BUDGET_MS = 45_000;
/** مهلة نداء التوليد الواحد — FLUX.1-schnell سريع وثوانٍ معدودة تكفيه بفضل */
const GENERATION_TIMEOUT_MS = 30_000;

/** تطبيع بادئة مفتاح HF إلى hf_ صغيرة (الجسم حساس لحالة الأحرف ويُحفظ كما هو) */
export function normalizeHfKey(key: string): string {
  return key.replace(/^hf_/i, "hf_");
}

/** تخمين نوع الصورة من magic bytes — يُستخدم للرفع وعمل الملف */
function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** استخراج رسالة خطأ HF من جسم JSON أو نص خام */
function hfErrMsg(raw: string): string {
  try {
    const b = JSON.parse(raw) as { error?: string; message?: string } | null;
    if (b?.error) return b.error;
    if (b?.message) return b.message;
  } catch {
    /* نص خام */
  }
  return raw.trim().replace(/\s+/g, " ").slice(0, 180);
}

/** أبعاد مقربة لكل نسبة شائعة (~1 ميجابكسل) — FLUX يقبل مضاعفات 8 */
const RATIO_SIZES: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1024, height: 576 },
  "9:16": { width: 576, height: 1024 },
  "4:3": { width: 1024, height: 768 },
  "3:4": { width: 768, height: 1024 },
  "3:2": { width: 1024, height: 680 },
  "2:3": { width: 680, height: 1024 },
};

/** تحميل العميل الرسمي ديناميكيًا — يعمل على serverless (ESM نقي بلا وحدات أصلية) */
async function loadInferenceClient(): Promise<typeof import("@huggingface/inference").InferenceClient> {
  const mod = (await import("@huggingface/inference")) as unknown as {
    InferenceClient: typeof import("@huggingface/inference").InferenceClient;
  };
  return mod.InferenceClient;
}

export const huggingfaceAdapter: ProviderAdapter = {
  // توليد صورة متزامن عبر FLUX.1-schnell — يعيد رابطًا مباشرًا بعد الرفع
  async createImageSync(rawKey, providerModel, input) {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) throw new ProviderHttpError("الوصف (prompt) مطلوب لمزود Hugging Face", 400);
    if (prompt.length > 2000) {
      throw new ProviderHttpError("وصف FLUX طويل جدًا (الحد 2000 حرفًا) — اختصر البرومبت", 400);
    }

    const apiKey = normalizeHfKey(rawKey);
    const model = providerModel || FLUX_MODEL_DEFAULT;
    const ratio = typeof input.aspect_ratio === "string" && input.aspect_ratio !== "auto" ? input.aspect_ratio : "";
    const size = RATIO_SIZES[ratio] ?? { width: 1024, height: 1024 };

    // ميزانية زمنية للعملية المتزامنة كلها (توليد + رفع) — نفس نمط cloudflare.ts
    const startedAt = Date.now();
    const remainingMs = () => SYNC_BUDGET_MS - (Date.now() - startedAt);

    let blob: Blob | null = null;
    let lastStatus: number | undefined;
    let lastMsg = "";

    // 1) المحاولة الرسمية: العميل الرسمي مع مزود تلقائي (يحسم fal-ai/nebius/hf-inference)
    try {
      const InferenceClient = await loadInferenceClient();
      const client = new InferenceClient(apiKey);
      // إجهاض نداء التوليد عند تجاوز الميزانية — إما صورة أو خطأ مُصنَّف،
      // لكن الميزانية المتبقية تبقى لسلسلة الرفع (أو data URL الفوري)
      const genSignal = AbortSignal.timeout(Math.max(5_000, Math.min(GENERATION_TIMEOUT_MS, remainingMs())));
      const out = (await client.textToImage({
        model,
        inputs: prompt,
        parameters: { width: size.width, height: size.height },
        // بلا تحديد مزود → auto (أول مزود متاح للموديل حسب ترتيب الحساب)
        signal: genSignal,
      } as never)) as unknown;
      // العميل يعيد Blob صورة (وعلى بعض الإصدارات نوعًا نصيًا نادرًا) — نوحّد إلى Blob
      blob = out instanceof Blob ? out : new Blob([typeof out === "string" ? out : JSON.stringify(out)], { type: "image/png" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // أخطاء العميل غير القابلة للتراجع تمطر مباشرة للنداء الخام: مصادقة/رصيد
      lastMsg = msg.replace(/^Failed to perform inference:\s*/i, "");
      // رمز الحالة إن وفره العميل الرسمي
      lastStatus = (e as { status?: number; httpResponse?: { status?: number } }).status
        ?? (e as { httpResponse?: { status?: number } }).httpResponse?.status;
      // «not supported by provider» → موديل لا يملك مزودًا نشطًا — جرّب مسار REST الخام
      if (/purchase|credits|quota|402/i.test(lastMsg)) {
        throw new ProviderHttpError(`Hugging Face: ${lastMsg}`, lastStatus ?? 402);
      }
      if (/^(401|403)/i.test(String(lastStatus)) || /invalid.*token|unauthorized|forbidden/i.test(lastMsg)) {
        throw new ProviderHttpError(`Hugging Face: ${lastMsg}`, lastStatus ?? 401);
      }
    }

    // 2) احتياط: نداء REST خام على مسار hf-inference (يعمل عند توفّر الموديل هناك)
    if (!blob) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.max(5_000, Math.min(GENERATION_TIMEOUT_MS, remainingMs())));
      try {
        const res = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ inputs: prompt, parameters: { width: size.width, height: size.height } }),
          signal: ctrl.signal,
        });
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (res.ok && ct.startsWith("image/")) {
          blob = await res.blob();
        } else {
          const raw = await res.text();
          if (res.ok) {
            // JSON يحتوي Base64؟
            try {
              const b = JSON.parse(raw) as { image?: string; images?: string[] } | null;
              const b64 = b?.image ?? b?.images?.[0] ?? "";
              if (b64) {
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                blob = new Blob([bytes as BlobPart], { type: ct || "image/png" });
              }
            } catch {
              /* ليس JSON صورة */
            }
          }
          if (!blob) {
            lastStatus = res.status;
            lastMsg = hfErrMsg(raw) || `HTTP ${res.status} من Hugging Face`;
          }
        }
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") lastMsg = "timeout";
        else lastMsg = e instanceof Error ? e.message : String(e);
        lastStatus = undefined;
      } finally {
        clearTimeout(timer);
      }
    }

    if (!blob) {
      throw new ProviderHttpError(`Hugging Face: ${lastMsg || "فشل غير معروف"}`, lastStatus);
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length === 0) {
      throw new ProviderHttpError("استجابة Hugging Face بلا بيانات صورة", 502);
    }

    // رفع السلسلة المشتركة — لا يُلقي أبدًا (data URL كحل أخير مضمون 100%)
    // remainingMs يجعل السلسلة تحترم الميزانية المتبقية: إن نفدت تُعاد الصورة
    // نفسها بصيغة data:image/...;base64 لحظيًا بدل أي خطأ رفع
    const finalType = sniffImageType(bytes) ?? "image/png";
    const url = await uploadViaHosts(bytes, finalType, remainingMs);
    return { urls: [url] };
  },

  // HF للصور المتزامنة فقط — لا مهام غير متزامنة
  async createTask() {
    throw new ProviderHttpError("مزود Hugging Face يدعم توليد الصور المتزامن فقط — لا مهام غير متزامنة", 501);
  },

  async checkTask() {
    return { status: "failed", error: "مزود Hugging Face لا يوفر استعلام مهام — المهمة متزامنة تكتمل فورًا" };
  },
};
