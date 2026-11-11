import type { ErrorClass } from "./types";

/**
 * تصنيف أخطاء المزودين — الجدول 4.2 في المواصفة.
 * ترتيب الفحص مقصود وصارم:
 *  1) disabled: 401/403 أو رسائل توثيق
 *  2) exhausted: 402 أو رسائل نفاد رصيد — تُفحص قبل 400 لأن بعض المزودين
 *     يرسلون نفاد الرصيد بحالة HTTP 400
 *  3) provider: موديل غير مدعوم مع 400/404/422
 *  4) params: 400/422 (معطيات الطلب) — توقف فورًا
 *  5) temporary: 429 / 5xx / شبكة — انتقل للتالي
 */
export function classifyProviderError(status: number | undefined, message: string): ErrorClass {
  const msg = (message || "").toLowerCase();

  // 1) مفتاح مرفوض → disabled
  if (status === 401 || status === 403) return "disabled";
  if (/invalid\s*api\s*key|unauthorized|forbidden|authentication|api\s*key\s*(is\s*)?invalid/.test(msg)) {
    return "disabled";
  }

  // 2) نفاد الرصيد → exhausted (قبل فحص 400!)
  if (status === 402) return "exhausted";
  if (/insufficient|quota|balance|credit|out\s*of\s*credits|exhausted|充值|no\s*enough/.test(msg)) {
    return "exhausted";
  }

  // 3) موديل غير مدعوم لدى هذا المزود → انتقل للمفتاح التالي (مزود آخر قد يدعمه)
  if (status === 400 || status === 404 || status === 422) {
    if (/model\s*not\s*found|unsupported\s*model|unknown\s*model|not\s*support.*model|model.*not\s*exist/.test(msg)) {
      return "provider";
    }
    // 4) معطيات طلب تالفة — تبديل المفاتيح لن يحلها
    return "params";
  }

  // 5) مؤقت: 429 و5xx وأي شيء آخر غير معروف (نجرّب المفتاح التالي)
  return "temporary";
}

/**
 * هل رسالة الفشل في منتصف المهمة تخص مفتاحًا/رصيدًا؟ (قسم 4.3.2)
 * عند التطابق تُعاد المهمة نفسها بنفس task_id على المفتاح التالي.
 */
export function isKeyOrBalanceRelated(message: string): boolean {
  const msg = (message || "").toLowerCase();
  return /insufficient|balance|credit|quota|402|401|unauthorized|exhausted|充值|invalid\s*api\s*key|forbidden|authentication/.test(msg);
}

/**
 * تنقية رسالة الخطأ قبل عرضها للعميل — القاعدة الذهبية 4:
 * نموذج الذكاء الاصطناعي لا يرى أبدًا أي ذكر لمفاتيح أو رصيد.
 */
export function sanitizeErrorForClient(message: string | null | undefined): string {
  if (!message) return "";
  let m = message;
  m = m.replace(/Bearer\s+[\w.\-]{6,}/gi, "***");
  m = m.replace(/abf6b97b8c107eec124b134dc25f4293/gi, "***"); // حماية إضافية من تسرب أي مفتاح في رسالة مزود
  if (/insufficient|balance|credit|quota|402|unauthorized|exhausted|充值|invalid\s*api\s*key|forbidden|authentication|api\s*key/i.test(m)) {
    return "تعذّر إكمال المهمة حاليًا بسبب مشكلة مؤقتة في خدمة التوليد — سيُعاد المحاولة تلقائيًا.";
  }
  return m.length > 500 ? m.slice(0, 500) + "…" : m;
}

/** إخفاء مفتاح API — إلزامي في كل الاستجابات والسجلات (القاعدة الذهبية 9) */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 14) {
    return key.slice(0, 3) + "•••••";
  }
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}
