import { ProviderHttpError, type ProviderAdapter } from "./types-adapter";

/**
 * مزود Cloudflare Workers AI — مزود الصور المجاني الأول بالترتيب (نقاط يومية مجانية):
 *
 * صيغة المفتاح المخزن في قاعدة البيانات:  ACCOUNT_ID:API_TOKEN
 * (يُفصلان عند أول نقطتين ":" لاستخراج accountId و apiToken)
 *
 * النداء:
 *   POST https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell
 *     Authorization: Bearer ${apiToken}
 *     Content-Type: application/json
 *     {"prompt": prompt}
 *
 * الاستجابة تقبل شكلين (يُفحص content-type ثم magic bytes كضمانة):
 *  - JSON يحتوي result.image بصيغة Base64 (الشكل الافتراضي لـ REST API)
 *  - صورة ثنائية خام (raw PNG/JPEG) إذا أعادها الخادم مباشرة
 *
 * القاعدة الذهبية للمشروع: روابط فقط — لذا تُرفع الصورة الناتجة بعد فك الترميز
 * إلى مضيف صور مجاني (catbox.moe ثم 0x0.st ثم litterbox كاحتياط) ويُعاد رابط
 * مباشر بنفس صيغة روابط الصور المعتمدة في بقية المزودات. فشل الرفع يُعامل
 * كخطأ مؤقت فينتقل التوليد تلقائيًا للمفتاح/المزود التالي.
 */

const CF_BASE = "https://api.cloudflare.com/client/v4";
const FLUX_MODEL_DEFAULT = "@cf/black-forest-labs/flux-1-schnell";

export interface CloudflareCreds {
  accountId: string;
  apiToken: string;
}

/** فصل مفتاح Cloudflare بصيغة ACCOUNT_ID:API_TOKEN عند أول نقطتين */
export function parseCloudflareKey(rawKey: string): CloudflareCreds {
  const idx = rawKey.indexOf(":");
  if (idx <= 0 || idx === rawKey.length - 1) {
    throw new ProviderHttpError("مفتاح Cloudflare تالف — الصيغة المطلوبة ACCOUNT_ID:API_TOKEN مفصولين بنقطتين", 400);
  }
  const accountId = rawKey.slice(0, idx).trim();
  const apiToken = rawKey.slice(idx + 1).trim();
  if (accountId.length < 4 || apiToken.length < 4) {
    throw new ProviderHttpError("مفتاح Cloudflare تالف — معرّف الحساب أو التوكن فارغ/قصير جدًا", 400);
  }
  return { accountId, apiToken };
}

/** تخمين نوع الصورة من البايتات الأولى (magic bytes) — null إن لم تكن صورة معروفة */
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

/** امتداد ملف مناسب لنوع الصورة */
function extForType(type: string): string {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  return "png";
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

/**
 * رفع الصورة إلى مضيف مجاني وإعادة رابط مباشر — يجرّب المضيفين بالترتيب:
 * catbox.moe (دائم) → 0x0.st (شهر فأكثر) → litterbox (24 ساعة)
 */
async function uploadImage(bytes: Uint8Array, contentType: string): Promise<string> {
  const ext = extForType(contentType);
  const filename = `meko-${Date.now()}.${ext}`;

  // 1) catbox.moe — روابط دائمة
  {
    const { signal, done } = withTimeout(30_000);
    try {
      const form = new FormData();
      form.append("reqtype", "fileupload");
      form.append("fileToUpload", new Blob([bytes as BlobPart], { type: contentType }), filename);
      const res = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: form, signal });
      const text = (await res.text()).trim();
      if (res.ok && /^https?:\/\/\S+$/.test(text)) return text;
    } catch {
      /* ننتقل للمضيف التالي */
    } finally {
      done();
    }
  }

  // 2) 0x0.st — احتفظ طويل
  {
    const { signal, done } = withTimeout(30_000);
    try {
      const form = new FormData();
      form.append("file", new Blob([bytes as BlobPart], { type: contentType }), filename);
      const res = await fetch("https://0x0.st", {
        method: "POST",
        body: form,
        signal,
        headers: { "User-Agent": "Meko-MCP/1.0 (media generator)" },
      });
      const text = (await res.text()).trim();
      if (res.ok && /^https?:\/\/\S+$/.test(text)) return text;
    } catch {
      /* ننتقل للمضيف التالي */
    } finally {
      done();
    }
  }

  // 3) litterbox — مؤقت 24 ساعة (احتياط أخير)
  {
    const { signal, done } = withTimeout(30_000);
    try {
      const form = new FormData();
      form.append("reqtype", "fileupload");
      form.append("time", "24h");
      form.append("fileToUpload", new Blob([bytes as BlobPart], { type: contentType }), filename);
      const res = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
        method: "POST",
        body: form,
        signal,
      });
      const text = (await res.text()).trim();
      if (res.ok && /^https?:\/\/\S+$/.test(text)) return text;
    } catch {
      /* تجاهل */
    } finally {
      done();
    }
  }

  throw new ProviderHttpError("تعذر رفع الصورة الناتجة من Cloudflare إلى أي مضيف صور — جرّب مزودًا آخر", 502);
}

export const cloudflareAdapter: ProviderAdapter = {
  // توليد صورة متزامن — يعيد رابطًا مباشرًا بعد الرفع
  async createImageSync(rawKey, providerModel, input) {
    const { accountId, apiToken } = parseCloudflareKey(rawKey);
    const model = providerModel || FLUX_MODEL_DEFAULT;
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) {
      throw new ProviderHttpError("الوصف (prompt) مطلوب لمزود Cloudflare Workers AI", 400);
    }

    // 1) نداء التوليد
    const genTimer = withTimeout(90_000);
    let res: Response;
    try {
      res = await fetch(`${CF_BASE}/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, image/*",
        },
        body: JSON.stringify({ prompt }),
        signal: genTimer.signal,
      });
    } catch (e) {
      throw new ProviderHttpError(
        `تعذر الوصول لـ Cloudflare Workers AI: ${e instanceof Error && e.name === "AbortError" ? "timeout" : e instanceof Error ? e.message : String(e)}`,
        undefined,
      );
    } finally {
      genTimer.done();
    }

    // 2) قراءة الاستجابة — نقرأ الجسم كاملًا ثم نفحصه على مرحلتين:
    //    أ) content-type: «image/png» أو «image/jpeg» أو أي image/* → صورة ثنائية خام
    //    ب) «application/json» → نستخرج result.image (Base64)
    //    ضمانة إضافية: لو وسم الخادم الجسم بـ octet-stream أو بدون وسم،
    //    نكشف magic bytes (PNG/JPEG/WEBP) ونعامله ثنائيًا حتى لو خالف الهيدر.
    const contentTypeHeader = (res.headers.get("content-type") || "").toLowerCase();
    const rawBytes = new Uint8Array(await res.arrayBuffer());
    const magicType = sniffImageType(rawBytes);
    const headerSaysImage = contentTypeHeader.startsWith("image/");
    const headerSaysJson = contentTypeHeader.includes("application/json");
    let imageBytes: Uint8Array | null = null;

    if (headerSaysImage || (!headerSaysJson && magicType)) {
      // صورة ثنائية خام (raw binary) — تحويلها لاحقًا إلى رابط عبر الرفع
      if (!res.ok) throw new ProviderHttpError(`HTTP ${res.status} من Cloudflare`, res.status);
      if (rawBytes.length > 0) imageBytes = rawBytes;
    } else {
      const text = new TextDecoder().decode(rawBytes);
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* جسم غير JSON — يُعالج أدناه كفشل HTTP */
      }
      const success = body.success === true;
      const errors = body.errors as Array<{ message?: string; code?: number }> | undefined;
      const errMsg = Array.isArray(errors) && errors.length > 0 ? errors.map((x) => x.message ?? String(x.code)).join("; ") : "";

      if (!res.ok) throw new ProviderHttpError(errMsg || `HTTP ${res.status} من Cloudflare`, res.status);
      if (!success || errMsg) throw new ProviderHttpError(errMsg || "استجابة Cloudflare بلا نجاح", res.status || 502);

      const result = body.result as { image?: string } | undefined;
      const b64 = typeof result?.image === "string" ? result.image : "";
      if (!b64) throw new ProviderHttpError("استجابة Cloudflare بلا صورة (result.image مفقود)", 502);
      try {
        // Base64 → بايتات خام (مكافئ لـ Buffer.from(b64, 'base64'))
        const bin = atob(b64);
        imageBytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) imageBytes[i] = bin.charCodeAt(i);
      } catch {
        throw new ProviderHttpError("تعذر فك ترميز Base64 لصورة Cloudflare", 502);
      }
    }

    if (!imageBytes || imageBytes.length === 0) {
      throw new ProviderHttpError(`استجابة Cloudflare بلا بيانات صورة (HTTP ${res.status})`, res.status || 502);
    }

    // 3) رفع الصورة وتحويلها إلى رابط مباشر بنفس صيغة المشروع
    //    (نستخدم magic bytes لتحديد النوع، ومع fallback الافتراضي PNG لناتج flux)
    const finalType = sniffImageType(imageBytes) ?? "image/png";
    const url = await uploadImage(imageBytes, finalType);
    return { urls: [url] };
  },

  // Cloudflare للصور المتزامنة فقط — لا مهام غير متزامنة
  async createTask() {
    throw new ProviderHttpError("مزود Cloudflare Workers AI يدعم توليد الصور المتزامن فقط — لا مهام غير متزامنة", 501);
  },

  async checkTask() {
    // لا تُستدعى أبدًا لمهام الصور المتزامنة (تكتمل فورًا) — احتياط للأمان فقط
    return { status: "failed", error: "مزود Cloudflare لا يوفر استعلام مهام — المهمة متزامنة تكتمل فورًا" };
  },
};
