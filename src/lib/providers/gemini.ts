import { uploadViaHosts } from "../upload";
import { ProviderHttpError, type ProviderAdapter } from "./types-adapter";

/**
 * مزود Google Gemini — مزدوج الدور:
 *  1) كتابة النصوص المنظمة (سكربت الفيديو، تقسيم المشاهد، هندسة البرومبتات)
 *     عبر gemini-2.5-flash مع مخرجات JSON منظمة — يُستخدم في خط إنتاج
 *     create_full_video عبر الدالة المصدّرة geminiGenerateJson.
 *  2) خط احتياطي لتوليد الصور عبر Imagen (predict endpoint) بصور متزامنة
 *     تُرفع عبر سلسلة الرفع الموثوقة المشتركة.
 *
 * صيغ المفاتيح المقبولة (كما هي بلا أي رفض أو تحويل):
 *  - AIza…  مفاتيح Google AI Studio
 *  - AQ.…   مفاتيح Google Cloud (الصيغة الجديدة) — تُقبل مثل AIza تمامًا
 *
 * المصادقة: ترويسة x-goog-api-key مع المفتاح الخام (تعمل مع كلتا الصيغتين).
 *
 * الموديلات:
 *  - النصوص: gemini-2.5-flash أولًا (اسم الموديل قابل للتجاوز بمتغير البيئة
 *    GEMINI_TEXT_MODEL)؛ عند 404 «no longer available» (المستخدمون الجدد بعد
 *    إيقاف الموديلات القديمة) يُجرَّب تلقائيًا gemini-flash-latest ثم
 *    gemini-3.8-flash — قائمة البدائل تتدرج للأحدث.
 *  - الصور: imagen-4.0-generate-001 أولًا (قابل للتجاوز بـ GEMINI_IMAGE_MODEL)
 *    وعند 404/مسار مفقود يُجرَّب imagen-3.0-generate-002.
 *
 * الأخطاء: 401/403 (مفتاح مرفوض) و400 «location not supported» (المفتاح سليم
 * لكن المنطقة محجوبة — مؤقت لأن المنطقة تعتمد على خادم Vercel نفسه) تُصنَّف
 * في errors.ts — الرفع عبر السلسلة المشتركة لا يُلقي أبدًا فلا يُعطَّل مفتاح
 * صالح بسبب مضيف رفع.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** ميزانية العملية المتزامنة كلها (توليد + رفع) — أقل من حد Vercel 60 ثانية بهامش آمن.
 *  سلسلة الرفع تشترك مع التوليد في الميزانية المتبقية عبر remainingMs: إن نفدت
 *  تتجاوز كل المضيفين فورًا ويُعاد data:image/...;base64 لحظيًا فلا يُرمى خطأ
 *  رفع أبدًا ولا تُقتل دالة Vercel قبل تحديث المهمة في Turso. */
const SYNC_BUDGET_MS = 45_000;
/** مهلة نداء Imagen الواحد لكل موديل */
const GENERATION_TIMEOUT_MS = 25_000;

const TEXT_MODEL_DEFAULT = "gemini-2.5-flash";
const IMAGE_MODEL_DEFAULT = "imagen-4.0-generate-001";

/** بدائل موديل النص — تُجرَّب بالترتيب عند 404 (موديل متقاد لمستخدم جديد) */
const TEXT_MODEL_FALLBACKS = ["gemini-flash-latest", "gemini-3.8-flash"];
/** بدائل موديل الصور — تُجرَّب عند 404 */
const IMAGE_MODEL_FALLBACKS = ["imagen-3.0-generate-002"];

function textModel(providerModel?: string): string {
  const env = process.env.GEMINI_TEXT_MODEL;
  return providerModel || (env && env.trim()) || TEXT_MODEL_DEFAULT;
}

function imageModel(providerModel?: string): string {
  const env = process.env.GEMINI_IMAGE_MODEL;
  return providerModel || (env && env.trim()) || IMAGE_MODEL_DEFAULT;
}

/** استخراج رسالة الخطأ من استجابة Google API بأي صيغة معروفة */
function googleErrMsg(body: unknown): string {
  const b = body as { error?: { message?: string; status?: string }; message?: string } | null;
  if (b && typeof b === "object") {
    if (b.error?.message) return b.error.message;
    if (typeof b.message === "string") return b.message;
  }
  return "";
}

/**
 * استدعاء generateContent مع قائمة موديلات متدرجة — يعيد (text, modelUsed).
 * يرمي ProviderHttpError عند فشل كل الموديلات بالصيغ المعروفة.
 */
async function generateContentWithFallback(
  rawKey: string,
  primaryModel: string,
  fallbacks: string[],
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ text: string; model: string }> {
  const models = [primaryModel, ...fallbacks];
  let lastStatus: number | undefined;
  let lastMsg = "";

  for (const model of models) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${API_BASE}/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": rawKey },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const raw = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* جسم غير JSON */
      }
      if (res.ok) {
        const b = body as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } | null;
        const text = b?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        if (text) return { text, model };
        lastMsg = "استجابة Gemini بلا نص (candidates مفقود)";
        lastStatus = res.status;
        continue; // موديل أعاد استجابة فارغة — جرّب التالي
      }
      lastStatus = res.status;
      lastMsg = googleErrMsg(body) || `HTTP ${res.status} من Google`;
      // 404: موديل غير متاح لهذا المستخدم → جرّب البديل الأحدث. الأخطاء الأخرى
      // (401/403 مفتاح، 400 منطقة/معطيات، 429 حد) لا تُصلحها قائمة الموديلات.
      if (res.status !== 404) break;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        lastMsg = "timeout";
        lastStatus = undefined;
        break;
      }
      lastMsg = e instanceof Error ? e.message : String(e);
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new ProviderHttpError(`Gemini API: ${lastMsg || "فشل غير معروف"}`, lastStatus);
}

/**
 * كتابة نص منظم من Gemini — يستخدمه خط إنتاج الفيديو (سكربت + مشاهد JSON).
 * يطلب responseMimeType: application/json فيُحلَّل الناتج JSON مباشرة.
 * الناتج يُقتطع من أغلفة ```json المحتملة دفاعًا لمن لا يحترم المimeType.
 */
export async function geminiGenerateJson(
  rawKey: string,
  prompt: string,
  opts: { timeoutMs?: number; temperature?: number; maxOutputTokens?: number; providerModel?: string } = {},
): Promise<Record<string, unknown>> {
  const { text } = await generateContentWithFallback(
    rawKey,
    textModel(opts.providerModel),
    TEXT_MODEL_FALLBACKS,
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: opts.temperature ?? 0.85,
        ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      },
    },
    opts.timeoutMs ?? 20_000,
  );
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    // استخراج أول كائن JSON متوازن من النص — بعض النسخ تضيف تعليقًا قبل القوس
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        /* يقع في الرمي أدناه */
      }
    }
    throw new ProviderHttpError("استجابة Gemini ليست JSON صالحًا رغم طلب responseMimeType", 502);
  }
}

/** نسب Imagen المقبولة رسميًا */
function imagenAspect(ratio?: string): string | null {
  const allowed = ["1:1", "3:4", "4:3", "9:16", "16:9"];
  return ratio && ratio !== "auto" && allowed.includes(ratio) ? ratio : null;
}

/** فك Base64 إلى بايتات */
function b64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export const geminiAdapter: ProviderAdapter = {
  // توليد صورة متزامن عبر Imagen — يعيد رابطًا مباشرًا بعد الرفع بالسلسلة المشتركة
  async createImageSync(rawKey, providerModel, input) {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) throw new ProviderHttpError("الوصف (prompt) مطلوب لمزود Google Gemini (Imagen)", 400);
    if (prompt.length > 3500) {
      throw new ProviderHttpError("وصف Imagen طويل جدًا (الحد 3500 حرفًا) — اختصر البرومبت", 400);
    }

    const primary = imageModel(providerModel);
    const aspect = imagenAspect(typeof input.aspect_ratio === "string" ? input.aspect_ratio : undefined);

    // ميزانية زمنية للعملية المتزامنة كلها (توليد + رفع) — نفس نمط cloudflare.ts
    const startedAt = Date.now();
    const remainingMs = () => SYNC_BUDGET_MS - (Date.now() - startedAt);

    const models = [primary, ...IMAGE_MODEL_FALLBACKS];
    let lastStatus: number | undefined;
    let lastMsg = "";
    let b64 = "";

    for (const model of models) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.max(6_000, Math.min(GENERATION_TIMEOUT_MS, remainingMs())));
      try {
        const res = await fetch(`${API_BASE}/${model}:predict`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": rawKey },
          body: JSON.stringify({
            instances: [{ prompt }],
            parameters: { sampleCount: 1, ...(aspect ? { aspectRatio: aspect } : {}) },
          }),
          signal: ctrl.signal,
        });
        const raw = await res.text();
        let body: unknown = null;
        try {
          body = JSON.parse(raw);
        } catch {
          /* جسم غير JSON */
        }
        if (res.ok) {
          const b = body as { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> } | null;
          const found = b?.predictions?.[0]?.bytesBase64Encoded ?? "";
          if (found) {
            b64 = found;
            break;
          }
          lastMsg = "استجابة Imagen بلا صورة (predictions مفقود)";
          lastStatus = res.status;
          continue;
        }
        lastStatus = res.status;
        lastMsg = googleErrMsg(body) || `HTTP ${res.status} من Imagen`;
        if (res.status !== 404 && res.status !== 403) break; // 403 قد يعني الموديل غير مرخّص للحساب — جرّب البديل
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          lastMsg = "timeout";
        } else {
          lastMsg = e instanceof Error ? e.message : String(e);
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }

    if (!b64) {
      throw new ProviderHttpError(`Gemini Imagen: ${lastMsg || "فشل غير معروف"}`, lastStatus);
    }
    const bytes = b64ToBytes(b64);
    if (!bytes || bytes.length === 0) {
      throw new ProviderHttpError("تعذر فك ترميز Base64 لصورة Imagen", 502);
    }

    // رفع السلسلة المشتركة — لا يُلقي أبدًا (data URL كحل أخير مضمون 100%)
    // remainingMs يجعل السلسلة تحترم الميزانية المتبقية: إن نفدت تُعاد الصورة
    // نفسها بصيغة data:image/...;base64 لحظيًا بدل أي خطأ رفع
    const url = await uploadViaHosts(bytes, "image/png", remainingMs);
    return { urls: [url] };
  },

  // Gemini للصور المتزامنة فقط في مسار المزودات — النصوص عبر geminiGenerateJson
  async createTask() {
    throw new ProviderHttpError("مزود Google Gemini يدعم توليد الصور المتزامن فقط — لا مهام غير متزامنة", 501);
  },

  async checkTask() {
    return { status: "failed", error: "مزود Gemini لا يوفر استعلام مهام — المهمة متزامنة تكتمل فورًا" };
  },
};
