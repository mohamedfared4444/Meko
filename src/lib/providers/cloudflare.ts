import { uploadViaHosts } from "../upload";
import { ProviderHttpError, type ProviderAdapter } from "./types-adapter";

/**
 * مزود Cloudflare Workers AI — مزود الصور المجاني الأول بالترتيب (نقاط يومية مجانية):
 *
 * صيغتا المفتاح المخزن في قاعدة البيانات:
 *  1) ACCOUNT_ID:API_TOKEN            ← مصادقة توكن API (Bearer Token)
 *  2) ACCOUNT_ID:EMAIL:GLOBAL_API_KEY ← مصادقة مفتاح API العام (Global API Key)
 *
 * النداء:
 *   POST https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell
 *     الصيغة 1: Authorization: Bearer ${apiToken}
 *     الصيغة 2: X-Auth-Email: ${email} + X-Auth-Key: ${globalApiKey} (بلا Authorization)
 *     Content-Type: application/json
 *     {"prompt": prompt}
 *
 * قاعدة المصادقة الحاسمة (نهائية بلا استثناء): الصيغة الثلاثية تُرسل دائمًا
 * بهيدرات X-Auth-Email / X-Auth-Key حتى لو بدأ المفتاح العام بـ Cfk_ أو كان
 * طوله 52 حرفًا (الصيغة الجديدة لمفاتيح Global API Key من Cloudflare) —
 * لا يُحوَّل أبدًا إلى Authorization: Bearer ولا يُجرَّب كتوكن، فالمفتاح العام
 * توثيقه يعمل حصريًا عبر الترويستين مع بريد الحساب.
 *
 * تطبيع البادئة (اختبار حي 2026-11): فاليّد Cloudflare لحالة أحرف بادئة المفتاح
 * العام الجديد — إرسال X-Auth-Key ببادئة Cfk_ كبيرة يعيد رفض 400/6103 «Invalid
 * format for X-Auth-Key header» حتى لو كان المفتاح صالحًا، بينما البادئة الصغيرة
 * cfk_ مع نفس الجسم (حساس لحالة الأحرف) تنجح في المصادقة والتوليد. لذا تُطبَّع
 * البادئة فقط إلى cfk_ صغيرة عند الفصل، ويُحفظ جسم المفتاح كما هو حرفيًا.
 *
 * الاستجابة تقبل شكلين (يُفحص content-type ثم magic bytes كضمانة):
 *  - JSON يحتوي result.image بصيغة Base64 (الشكل الافتراضي لـ REST API)
 *  - صورة ثنائية خام (raw PNG/JPEG) إذا أعادها الخادم مباشرة
 *
 * القاعدة الذهبية للمشروع: روابط فقط — لذا تُرفع الصورة الناتجة بعد فك الترميز
 * إلى مضيف صور مجاني ويُعاد رابط مباشر بنفس صيغة روابط الصور المعتمدة في بقية
 * المزودات.
 *
 * سلسلة مضيفي الرفع (بالترتيب، مع تبديل تلقائي عند أي فشل):
 *  1) tmpfiles.org  — بلا حظر لـ IP المراكز البيانات (مثبت باختبار حي 2026-11)،
 *     ملف JSON نظيف، والرابط الناتج يُحوَّل لرابط مباشر بإضافة /dl/ بعد اسم
 *     النطاق (مع محاولة استخراج الرابط المباشر الموقّع من صفحة الملف أولًا).
 *  2) uguu.se       — رفع JSON سريع (files[]).
 *  3) litterbox     — مؤقت 72 ساعة (reqtype=fileupload + time=72h).
 *  4) catbox.moe    — روابط دائمة.
 *  5) 0x0.st        — احتفظ طويل.
 *  6) الحل الأخير المضمون: إذا فشلت كل مواقع الرفع الخارجية تُعاد الصورة نفسها
 *     بصيغة data:image/...;base64 — الصورة لا تضيع أبدًا حتى لو حجبت كل المضيفين.
 *
 * قاعدة حاسمة لحماية المفاتيح: فشل الرفع الخارجي بعد نجاح التوليد ليس عيبًا في
 * المفتاح — مع هذا السقوط النهائي لا يمكن لسلسلة الرفع أن تفشل أصلًا، وأي خطأ
 * رفع يُصنَّف في errors.ts كـ temporary ولا يُعطِّل مفتاح Cloudflare الصالح أبدًا
 * (التعطيل التلقائي حصرًا لأخطاء المصادقة 401/403 أو نفاد الرصيد).
 *
 * ميزانية زمنية صارمة (SYNC_BUDGET_MS ≈ 45 ثانية للعملية المتزامنة كلها):
 * التوليد المتزامن يجري داخل نداء generate_image نفسه على Vercel (حد الدالة
 * 60 ثانية) — لو تجاوز النداء الحد تُقتل الدالة قبل تحديث المهمة في Turso
 * فتبقى عالقة عند 0%. لذا مهلة التوليد 25 ثانية (flux-1-schnell يستغرق
 * ثوانٍ معدودة) والرفع يشترك معه في الميزانية المتبقية بمهلة 12 ثانية
 * كحد أقصى لكل مضيف، وتحويل data URL لحظي بلا أي شبكة فلا يتجاوز أبدًا.
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

/** نوع المصادقة: توكن Bearer أو مفتاح API العام (X-Auth-Email / X-Auth-Key) */
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
 * ملاحظة: الصيغة الثلاثية لا تُحوَّل إلى Bearer إطلاقًا — حتى لو بدأ المفتاح
 * بـ Cfk_ أو كان 52 حرفًا؛ تُرسل الترويستان دائمًا (بعد تطبيع بادئة cfk_).
 */

/**
 * تطبيع بادئة المفتاح العام الجديد (Global API Key بصيغة scannable):
 * فاليّد Cloudflare لحالة أحرف البادئة فقط — «Cfk_» الكبيرة تُرفض بـ 6103
 * «Invalid format for X-Auth-Key header»، و«cfk_» الصغيرة تُقبل.
 * تُصغَّر البادئة فقط ويُحفظ جسم المفتاح كما هو (الجسم حساس لحالة الأحرف)،
 * والمفتاح القديم hex (37 حرفًا) يمر كما هو بلا أي تعديل.
 */
function normalizeGlobalApiKey(key: string): string {
  return /^cfk_/i.test(key) ? "cfk_" + key.slice(4) : key;
}

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
    return { accountId, auth: { kind: "globalKey", email, globalApiKey: normalizeGlobalApiKey(globalApiKey) } };
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

/** رفع الصورة عبر السلسلة المشتركة الموثوقة (tmpfiles → uguu → litterbox 72h → catbox → 0x0.st → data URL) */
async function uploadImage(bytes: Uint8Array, contentType: string, remainingMs: () => number): Promise<string> {
  return uploadViaHosts(bytes, contentType, remainingMs);
}

/** مهلة إجبارية لنداء التوليد — إجهاض الطلب عند تجاوز الميزانية الزمنية */
function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
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

    // 1) نداء التوليد — الهيدرات حسب نوع المفتاح: Bearer أو X-Auth-Email/X-Auth-Key.
    //    الصيغة الثلاثية تُرسل دائمًا بهيدرات المفتاح العام كما هي — حتى لو بدأ
    //    المفتاح بـ Cfk_ أو كان 52 حرفًا — ولا يُجرَّب أبداً كتوكن Bearer.
    //    أي فشل هنا يُعاد للمفتاح/المزود التالي مباشرة (بلا محاولات بديلة).
    const genBudget = Math.max(5_000, Math.min(GENERATION_TIMEOUT_MS, remainingMs()));
    let res: Response | null = null;
    let primaryError: unknown = null;
    {
      const timer = withTimeout(genBudget);
      try {
        res = await fetch(`${CF_BASE}/accounts/${encodeURIComponent(creds.accountId)}/ai/run/${model}`, {
          method: "POST",
          headers: {
            ...cloudflareAuthHeaders(creds),
            "Content-Type": "application/json",
            Accept: "application/json, image/*",
          },
          body: JSON.stringify({ prompt }),
          signal: timer.signal,
        });
      } catch (e) {
        primaryError = e;
      } finally {
        timer.done();
      }
    }

    if (!res) {
      const raw =
        primaryError instanceof Error && primaryError.name === "AbortError"
          ? "timeout"
          : primaryError instanceof Error
            ? primaryError.message
            : String(primaryError);
      if (/bytestring|invalid character in header/i.test(raw)) {
        throw new ProviderHttpError(
          "مفتاح Cloudflare يحتوي أحرفًا غير صالحة لترويسات HTTP (Invalid token characters) — غالبًا بريد بنص عربي أو نائب نصي مثل «بريدك_الإلكتروني». الصيغة الصحيحة: ACCOUNT_ID:API_TOKEN أو ACCOUNT_ID:EMAIL:GLOBAL_API_KEY ببريد حقيقي لاتيني",
          400,
        );
      }
      throw new ProviderHttpError(`تعذر الوصول لـ Cloudflare Workers AI: ${raw}`, undefined);
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

      // تلميح الصيغة عند فشل مصادقة المفتاح العام — يساعد على تصحيح المفتاح فورًا
      // (المفتاح العام قد يكون بالصيغة الجديدة التي تبدأ بـ cfk_ أو القديمة hex)
      const authHint =
        creds.auth.kind === "globalKey" && (res.status === 400 || res.status === 401 || res.status === 403)
          ? " — تأكد أن الجزء الثاني بريد الحساب الصحيح وأن الجزء الثالث هو Global API Key من صفحة My Profile → API Tokens (الصيغة الجديدة تبدأ بـ cfk_ وتُطبَّع بادئتها تلقائيًا عند الإرسال، والقديمة 37 حرفًا hex)"
          : "";

      if (!res.ok) throw new ProviderHttpError((errMsg || `HTTP ${res.status} من Cloudflare`) + authHint, res.status);
      if (!success || errMsg) throw new ProviderHttpError((errMsg || "استجابة Cloudflare بلا نجاح") + authHint, res.status || 502);

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
