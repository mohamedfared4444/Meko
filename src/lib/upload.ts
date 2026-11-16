/**
 * سلسلة الرفع الموثوقة المشتركة — تستخدمها كل المزودات (cloudflare، huggingface)
 * وأدوات الصوت (edge-tts) لتحويل الوسائط الناتجة إلى روابط مباشرة عامة.
 *
 * سلسلة المضيفين (بالترتيب، مع تبديل تلقائي عند أي فشل):
 *  1) tmpfiles.org  — بلا حظر لـ IP المراكز البيانات (مثبت باختبار حي 2026-11)؛
 *     الرابط الناتج يُحوَّل لرابط مباشر بإضافة /dl/ بعد اسم النطاق (مع محاولة
 *     استخراج الرابط الموقّع من صفحة الملف أولًا — يقدّم الملف الخام فعليًا).
 *  2) uguu.se       — رفع JSON سريع (files[]).
 *  3) litterbox     — مؤقت 72 ساعة (reqtype=fileupload + time=72h).
 *  4) catbox.moe    — روابط دائمة.
 *  5) 0x0.st        — احتفظ طويل (يطلب ترويسة عميل مخصص).
 *  6) الحل الأخير المضمون: إعادة الوسائط نفسها بصيغة data:<mime>;base64 —
 *     لا تضيع أي نتيجة أبدًا حتى لو حُجبت كل المضيفين.
 *
 * قاعدة حماية المفاتيح: هذه الدالة لا تُلقي خطأ أبدًا — فشل الرفع الخارجي بعد
 * نجاح التوليد ليس عيبًا في المفتاح، وأي خطأ رفع يُصنَّف في errors.ts كـ
 * temporary ولا يُعطِّل مفتاحًا صالحًا (التعطيل حصرًا لمصادقة/رصيد).
 */

/** مهلة مضيف واحد كحد أقصى */
export const UPLOAD_TIMEOUT_MS = 12_000;
/** أقل مهلة مفيدة للرفع — أقل من ذلك تعني نفاد الميزانية فلا مجد للمحاولة */
export const MIN_USEFUL_TIMEOUT_MS = 2_500;

/**
 * User-Agent واقعي لطلبات الرفع — بعض المضيفين (catbox/litterbox) يرفضون الترويسة
 * الافتراضية لـ Node/undici القادمة من سيرفرات Vercel برسالة 412 «Invalid uploader»،
 * وترويسة متصفح منطقية تتجاوز ذلك الفلتر البسيط. (0x0.st يستثنى عمدًا — يرفض
 * ترويسات المتصفحات ويطلب ترويسة عميل مخصص.)
 */
const UPLOAD_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

/** هل النص رابط http/https صالحًا؟ (شرط قبول نتيجة أي مضيف) */
function isHttpUrl(text: string): boolean {
  return /^https:\/\/\S+$/.test(text) || /^http:\/\/\S+$/.test(text);
}

/** امتداد ملف مناسب لنوع MIME */
export function extForMime(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "mp3";
  if (mime === "audio/wav") return "wav";
  if (mime === "audio/ogg") return "ogg";
  if (mime.startsWith("audio/")) return mime.slice(6).replace(/[^a-z0-9]/g, "") || "bin";
  return "png";
}

/** الحل الأخير المضمون — الوسائط نفسها كـ data URL فلا تضيع أبدًا */
export function toDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * رفع الوسائط إلى مضيف مجاني وإعادة رابط مباشر — لا تُلقي خطأ أبدًا.
 * remainingMs: دالة تعيد الميزانية الزمنية المتبقية للعملية المتزامنة كلها
 * (تُمرَّر من المزود لضمان عدم تجاوز حد دالة Vercel). إن أُهملت تُعامل كل
 * محاولة بالمهلة الكاملة 12 ثانية.
 */
export async function uploadViaHosts(
  bytes: Uint8Array,
  mime: string,
  remainingMs?: () => number,
): Promise<string> {
  const remaining = remainingMs ?? (() => Number.MAX_SAFE_INTEGER);
  const filename = `meko-${Date.now()}.${extForMime(mime)}`;

  // 1) tmpfiles.org — بلا حظر لـ IP المراكز البيانات (أولوية أولى مثبتة بالاختبار الحي)
  {
    const budget = Math.min(UPLOAD_TIMEOUT_MS, remaining());
    if (budget >= MIN_USEFUL_TIMEOUT_MS) {
      const { signal, done } = withTimeout(budget);
      try {
        const form = new FormData();
        form.append("file", new Blob([bytes as BlobPart], { type: mime }), filename);
        const res = await fetch("https://tmpfiles.org/api/v1/upload", { method: "POST", body: form, signal, headers: { "User-Agent": UPLOAD_UA } });
        const text = (await res.text()).trim();
        if (res.ok) {
          const parsed = JSON.parse(text) as { status?: string; data?: { url?: string } };
          const plain = parsed.data?.url ?? "";
          if (parsed.status === "success" && isHttpUrl(plain)) {
            // تحويل الرابط الناتج إلى رابط مباشر: نحاول أولًا استخراج الرابط
            // الموقّع من صفحة الملف (الشكل https://tmpfiles.org/dl/<ts>.<hash>/…
            // ويقدّم الملف الخام فعليًا)، وإلا نطبّق القاعدة الأساسية بإضافة
            // /dl/ بعد اسم النطاق مباشرة.
            try {
              const pageCtrl = new AbortController();
              const pageTimer = setTimeout(() => pageCtrl.abort(), Math.min(5_000, remaining()));
              try {
                const page = await fetch(plain, { signal: pageCtrl.signal, headers: { "User-Agent": UPLOAD_UA } });
                const html = await page.text();
                const signed = html.match(/https:\/\/tmpfiles\.org\/dl\/\d+\.[0-9a-f]+\/\S+/)?.[0];
                if (signed) return signed.replace(/["'<>].*$/, "");
              } finally {
                clearTimeout(pageTimer);
              }
            } catch {
              /* استخراج الصفحة فشل — نرجع لقاعدة /dl/ الأساسية */
            }
            const dl = plain.replace("https://tmpfiles.org/", "https://tmpfiles.org/dl/");
            if (isHttpUrl(dl)) return dl;
          }
        }
      } catch {
        /* ننتقل للمضيف التالي */
      } finally {
        done();
      }
    }
  }

  // 2) uguu.se — رفع JSON سريع (files[])
  {
    const budget = Math.min(UPLOAD_TIMEOUT_MS, remaining());
    if (budget >= MIN_USEFUL_TIMEOUT_MS) {
      const { signal, done } = withTimeout(budget);
      try {
        const form = new FormData();
        form.append("files[]", new Blob([bytes as BlobPart], { type: mime }), filename);
        const res = await fetch("https://uguu.se/upload", { method: "POST", body: form, signal, headers: { "User-Agent": UPLOAD_UA } });
        const text = (await res.text()).trim();
        if (res.ok) {
          const parsed = JSON.parse(text) as { success?: boolean; files?: Array<{ url?: string }> };
          const url = parsed.files?.[0]?.url ?? "";
          if (parsed.success === true && isHttpUrl(url)) return url;
        }
      } catch {
        /* ننتقل للمضيف التالي */
      } finally {
        done();
      }
    }
  }

  // 3) litterbox — مؤقت 72 ساعة (reqtype=fileupload + time=72h)
  {
    const budget = Math.min(UPLOAD_TIMEOUT_MS, remaining());
    if (budget >= MIN_USEFUL_TIMEOUT_MS) {
      const { signal, done } = withTimeout(budget);
      try {
        const form = new FormData();
        form.append("reqtype", "fileupload");
        form.append("time", "72h");
        form.append("fileToUpload", new Blob([bytes as BlobPart], { type: mime }), filename);
        const res = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
          method: "POST",
          body: form,
          signal,
          headers: { "User-Agent": UPLOAD_UA },
        });
        const text = (await res.text()).trim();
        if (res.ok && isHttpUrl(text)) return text;
      } catch {
        /* ننتقل للمضيف التالي */
      } finally {
        done();
      }
    }
  }

  // 4) catbox.moe — روابط دائمة
  {
    const budget = Math.min(UPLOAD_TIMEOUT_MS, remaining());
    if (budget >= MIN_USEFUL_TIMEOUT_MS) {
      const { signal, done } = withTimeout(budget);
      try {
        const form = new FormData();
        form.append("reqtype", "fileupload");
        form.append("fileToUpload", new Blob([bytes as BlobPart], { type: mime }), filename);
        const res = await fetch("https://catbox.moe/user/api.php", {
          method: "POST",
          body: form,
          signal,
          headers: { "User-Agent": UPLOAD_UA },
        });
        const text = (await res.text()).trim();
        if (res.ok && isHttpUrl(text)) return text;
      } catch {
        /* ننتقل للمضيف التالي */
      } finally {
        done();
      }
    }
  }

  // 5) 0x0.st — احتفظ طويل (يطلب ترويسة عميل مخصص ولا يقبل ترويسات المتصفحات)
  {
    const budget = Math.min(UPLOAD_TIMEOUT_MS, remaining());
    if (budget >= MIN_USEFUL_TIMEOUT_MS) {
      const { signal, done } = withTimeout(budget);
      try {
        const form = new FormData();
        form.append("file", new Blob([bytes as BlobPart], { type: mime }), filename);
        const res = await fetch("https://0x0.st", {
          method: "POST",
          body: form,
          signal,
          headers: { "User-Agent": "Meko-MCP/1.0 (media generator)" },
        });
        const text = (await res.text()).trim();
        if (res.ok && isHttpUrl(text)) return text;
      } catch {
        /* ننتقل للمضيف التالي */
      } finally {
        done();
      }
    }
  }

  // 6) الحل الأخير المضمون — كل مواقع الرفع الخارجية فشلت → الوسائط نفسها
  //    كـ data URL (لحظي، بلا شبكة): النتيجة لا تضيع أبدًا ولا تُعطَّل مفتاح
  //    صالح بسبب فشل رفع طرف ثالث.
  return toDataUrl(bytes, mime);
}
