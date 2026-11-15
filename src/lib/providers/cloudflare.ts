import { ProviderHttpError, type ProviderAdapter } from "./types-adapter";

/**
 * مزود Cloudflare Workers AI — مزود الصور المجاني الأول بالترتيب (نقاط يومية مجانية):
 *
 * صيغتا المفتاح المخزن في قاعدة البيانات:
 *  1) ACCOUNT_ID:API_TOKEN            ← مصادقة توكن API (Bearer Token)
 *  2) ACCOUNT_ID:EMAIL:GLOBAL_API_KEY ← مصادقة مفتاح API العام القديم (Global API Key)
 *
 * النداء:
 *   POST https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell
 *     الصيغة 1: Authorization: Bearer ${apiToken}
 *     الصيغة 2: X-Auth-Email: ${email} + X-Auth-Key: ${globalApiKey} (بلا Authorization)
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
 *
 * ميزانية زمنية صارمة (SYNC_BUDGET_MS ≈ 45 ثانية للعملية المتزامنة كلها):
 * التوليد المتزامن يجري داخل نداء generate_image نفسه على Vercel (حد الدالة
 * 60 ثانية) — لو تجاوز النداء الحد تُقتل الدالة قبل تحديث المهمة في Turso
 * فتبقى عالقة عند 0%. لذا مهلة التوليد 25 ثانية (flux-1-schnell يستغرق
 * ثوانٍ معدودة) والرفع يشترك معه في الميزانية المتبقية بمهلة 12 ثانية
 * كحد أقصى لكل مضيف.
 */

const CF_BASE = "https://api.cloudflare.com/client/v4";
const FLUX_MODEL_DEFAULT = "@cf/black-forest-labs/flux-1-schnell";

/** ميزانية العملية المتزامنة كلها (توليد + رفع) — أقل من حد Vercel 60 ثانية بهامش آمن */
const SYNC_BUDGET_MS = 45_000;
/** مهلة نداء التوليد — flux-1-schnell سريع وثوانٍ معدودة تكفيه بفضل */
const GENERATION_TIMEOUT_MS = 25_000;
/** أقصى مهلة لرفع الصورة إلى مضيف واحد */
const UPLOAD_TIMEOUT_MS = 12_000;
/** أقل مهلة مفيدة للرفع — أقل من ذلك تعني نفاد الميزانية فلا مجد للمحاولة */
const MIN_USEFUL_TIMEOUT_MS = 2_500;

/** نوع المصادقة: توكن Bearer أو مفتاح API العام القديم (X-Auth-Email / X-Auth-Key) */
type CloudflareAuth =
  | { kind: "bearer"; apiToken: string }
  | { kind: "globalKey"; email: string; globalApiKey: string };

export interface CloudflareCreds {
  accountId: string;
  auth: CloudflareAuth;
}

/**
 * فصل مفتاح Cloudflare بصيغتيه المقبولتين:
 *  - ACCOUNT_ID:API_TOKEN (جزآن) → مصادقة Bearer
 *  - ACCOUNT_ID:EMAIL:GLOBAL_API_KEY (ثلاثة أجزاء) → مصادقة مفتاح API العام
 * الأجزاء تُطهَّر من الفراغات، والبريد يجب أن يحتوي @ في الصيغة الثلاثية.
 */
export function parseCloudflareKey(rawKey: string): CloudflareCreds {
  const parts = rawKey.trim().split(":").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2) {
    throw new ProviderHttpError(
      "مفتاح Cloudflare تالف — الصيغ المطلوبة: ACCOUNT_ID:API_TOKEN أو ACCOUNT_ID:EMAIL:GLOBAL_API_KEY (مفصولة بنقطتين)",
      400,
    );
  }
  const accountId = parts[0];
  if (accountId.length < 4) {
    throw new ProviderHttpError("مفتاح Cloudflare تالف — معرّف الحساب (ACCOUNT_ID) فارغ/قصير جدًا", 400);
  }

  if (parts.length === 2) {
    const apiToken = parts[1];
    if (apiToken.length < 4) {
      throw new ProviderHttpError("مفتاح Cloudflare تالف — التوكن (API_TOKEN) فارغ/قصير جدًا", 400);
    }
    return { accountId, auth: { kind: "bearer", apiToken } };
  }

  if (parts.length === 3) {
    const email = parts[1];
    const globalApiKey = parts[2];
    if (!email.includes("@") || email.length < 6) {
      throw new ProviderHttpError("مفتاح Cloudflare تالف — الجزء الثاني في الصيغة الثلاثية يجب أن يكون بريد الحساب (EMAIL) صحيحًا", 400);
    }
    if (globalApiKey.length < 4) {
      throw new ProviderHttpError("مفتاح Cloudflare تالف — مفتاح API العام (GLOBAL_API_KEY) فارغ/قصير جدًا", 400);
    }
    return { accountId, auth: { kind: "globalKey", email, globalApiKey } };
  }

  throw new ProviderHttpError(
    `مفتاح Cloudflare تالف — عدد الأجزاء ${parts.length} غير معروف. الصيغ المقبولة: ACCOUNT_ID:API_TOKEN أو ACCOUNT_ID:EMAIL:GLOBAL_API_KEY`,
    400,
  );
}

/** بناء هيدرات المصادقة حسب نوع المفتاح — Bearer أو X-Auth-Email/X-Auth-Key */
function cloudflareAuthHeaders(creds: CloudflareCreds): Record<string, string> {
  if (creds.auth.kind === "bearer") {
    return { Authorization: `Bearer ${creds.auth.apiToken}` };
  }
  return {
    "X-Auth-Email": creds.auth.email,
    "X-Auth-Key": creds.auth.globalApiKey,
  };
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
 * مهلة كل مضيف تنقص من الميزانية المتبقية للعملية المتزامنة حتى لا نتجاوز
 * حد دالة Vercel وتُقتل قبل تحديث المهمة في قاعدة البيانات.
 */
async function uploadImage(bytes: Uint8Array, contentType: string, remainingMs: () => number): Promise<string> {
  const ext = extForType(contentType);
  const filename = `meko-${Date.now()}.${ext}`;

  // 1) catbox.moe — روابط دائمة
  {
    const budget = Math.min(UPLOAD_TIMEOUT_MS, remainingMs());
    if (budget < MIN_USEFUL_TIMEOUT_MS) {
      throw new ProviderHttpError("نفدت الميزانية الزمنية قبل رفع صورة Cloudflare — جرّب مزودًا آخر", 504);
    }
    const { signal, done } = withTimeout(budget);
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
    const budget = Math.min(UPLOAD_TIMEOUT_MS, remainingMs());
    if (budget < MIN_USEFUL_TIMEOUT_MS) {
      throw new ProviderHttpError("نفدت الميزانية الزمنية قبل رفع صورة Cloudflare — جرّب مزودًا آخر", 504);
    }
    const { signal, done } = withTimeout(budget);
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
    const budget = Math.min(UPLOAD_TIMEOUT_MS, remainingMs());
    if (budget < MIN_USEFUL_TIMEOUT_MS) {
      throw new ProviderHttpError("نفدت الميزانية الزمنية قبل رفع صورة Cloudflare — جرّب مزودًا آخر", 504);
    }
    const { signal, done } = withTimeout(budget);
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
    const creds = parseCloudflareKey(rawKey);
    const model = providerModel || FLUX_MODEL_DEFAULT;
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) {
      throw new ProviderHttpError("الوصف (prompt) مطلوب لمزود Cloudflare Workers AI", 400);
    }

    // ميزانية زمنية للعملية المتزامنة كلها (توليد + رفع) — لو تجاوزناها تُقتل
    // دالة Vercel قبل تحديث المهمة في Turso فتبقى عالقة عند 0% بلا نتيجة
    const startedAt = Date.now();
    const remainingMs = () => SYNC_BUDGET_MS - (Date.now() - startedAt);

    // 1) نداء التوليد — الهيدرات حسب نوع المفتاح: Bearer أو X-Auth-Email/X-Auth-Key
    const genBudget = Math.max(5_000, Math.min(GENERATION_TIMEOUT_MS, remainingMs()));
    const genTimer = withTimeout(genBudget);
    let res: Response;
    try {
      res = await fetch(`${CF_BASE}/accounts/${encodeURIComponent(creds.accountId)}/ai/run/${model}`, {
        method: "POST",
        headers: {
          ...cloudflareAuthHeaders(creds),
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
        /* جسم غير JSON — يُعالج أدناه كفشل HTTP بمقتطف الجسم الخام */
      }
      const success = body.success === true;
      const errors = body.errors as Array<{ message?: string; code?: number }> | undefined;
      // الخطأ الحقيقي القادم من Cloudflare API يُستخرج بأي صيغة معروفة — هذا
      // النص هو ما يُسجل لاحقًا في last_error للمفتاح (شفافية التشخيص)
      let errMsg = Array.isArray(errors) && errors.length > 0 ? errors.map((x) => x.message ?? String(x.code)).join("; ") : "";
      if (!errMsg) {
        // صيغ بديلة تُعيد بعض نقاط Cloudflare: {"error": "نص"} أو {"error": {"message": "نص"}}
        const alt = body.error as { message?: string } | string | undefined;
        if (typeof alt === "string") errMsg = alt;
        else if (alt && typeof alt === "object" && typeof alt.message === "string") errMsg = alt.message;
      }
      if (!errMsg && !res.ok) {
        // لا رسالة مهيكلة — أدرج مقتطفًا من الجسم الخام حتى لا يُفقد النص الحقيقي للخطأ
        const snippet = text.trim().replace(/\s+/g, " ").slice(0, 180);
        errMsg = snippet ? `HTTP ${res.status} من Cloudflare: ${snippet}` : "";
      }

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
    const url = await uploadImage(imageBytes, finalType, remainingMs);
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
