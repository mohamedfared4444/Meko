/**
 * تعقيم قيم متغيرات البيئة — وحدة مشتركة تستخدمها طبقة Turso وخدمة الدمج.
 *
 * لماذا؟ المتغيرات المضبوطة في Vercel قد تصل إليك ملوثة:
 *  - مسافات/أسطر جديدة من الطرفين (خطأ لصق شائع)
 *  - اقتباسات محيطة ""..."" (بعض المستخدمين يلصقون القيمة بين علامتي تنصيص)
 *  - أحرف غير مرئية تفسد كل شيء: علامات الاتجاه RTL/LRM (تُدخل عند النسخ من
 *    محادثات عربية)، مسافة غير فاصلة NBSP، مسافة صفرية، BOM —
 *    هذه لا يزيلها trim ولا ترمي fetch سوى «Invalid URL» غامض
 */

// NBSP، SHY، مسافات يونيكود المختلفة، علامات الاتجاه والإدخال، BOM، فاصل أسطر U+2028/2029
const INVISIBLE_CHARS = /[\u00A0\u00AD\u1680\u2000-\u200F\u202A-\u202E\u2066-\u2069\u2060\uFEFF\u2028\u2029]/g;

/** تعقيم قيمة متغير بيئة: إزالة الأحرف غير المرئية ثم المسافات ثم الاقتباسات المحيطة */
export function sanitizeEnvValue(raw: string | undefined | null): string {
  return (raw ?? "")
    .replace(INVISIBLE_CHARS, "")
    .trim()
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .trim();
}

/** تحويل رابط Turso libsql:// إلى https:// (مكافئ 100% لدى Turso) مع تنظيف الشكل */
export function normalizeTursoUrl(raw: string | undefined | null): string {
  let url = sanitizeEnvValue(raw);
  if (!url) return "";
  if (/^libsql:\/\//i.test(url)) url = "https://" + url.slice("libsql://".length);
  return url.replace(/\/+$/, "");
}

/** إخفاء جزء من قيمة حساسة عند عرضها في رسائل التشخيص */
export function maskEnvValue(v: string): string {
  if (v.length <= 12) return v.slice(0, 4) + "…";
  return v.slice(0, 10) + "…" + v.slice(-4);
}
