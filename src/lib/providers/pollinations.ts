import { ProviderHttpError, type ProviderAdapter } from "./types-adapter";

/**
 * مزود Pollinations.ai — مجاني مفتوح بالكامل ولا يتطلب API Key حقيقيًا.
 * المفتاح المخزن في قاعدة البيانات يقبل أي نص تعريفي (مثل «free») ولا يُستخدم فعلًا.
 *
 * التوليد مباشرة عبر الرابط (يُولَّد عند أول GET من أي عميل):
 *   https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?model=flux&nologo=true&width=1024&height=1024
 *
 * يعيد المزود الرابط فورًا كصورة متزامنة (createImageSync) — بلا مهام غير متزامنة.
 * seed عشوائي يُضاف لتجنب إرجاع صورة مخبأة لنفس الوصف عند التكرار.
 */

const BASE = "https://image.pollinations.ai/prompt";

/** خريطة نسب الأبعاد إلى مقاسات مقربة تحافظ على ~1 ميجابكسل */
const RATIO_SIZES: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "3:2": { width: 1248, height: 832 },
  "2:3": { width: 832, height: 1248 },
  "4:3": { width: 1152, height: 864 },
  "3:4": { width: 864, height: 1152 },
  "2:1": { width: 1344, height: 672 },
  "1:2": { width: 672, height: 1344 },
  "21:9": { width: 1344, height: 576 },
  "9:21": { width: 576, height: 1344 },
};

export const pollinationsAdapter: ProviderAdapter = {
  // توليد صورة متزامن — يعيد رابط Pollinations المباشر فورًا
  async createImageSync(_key, providerModel, input) {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) {
      throw new ProviderHttpError("الوصف (prompt) مطلوب لمزود Pollinations", 400);
    }

    const model = providerModel || "flux";
    const ratio = typeof input.aspect_ratio === "string" && input.aspect_ratio !== "auto" ? input.aspect_ratio : "";
    const size = RATIO_SIZES[ratio] ?? { width: 1024, height: 1024 };
    const seed = Math.floor(Math.random() * 1_000_000);

    const url =
      `${BASE}/${encodeURIComponent(prompt)}?model=${encodeURIComponent(model)}` +
      `&nologo=true&width=${size.width}&height=${size.height}&seed=${seed}`;

    return { urls: [url] };
  },

  // Pollinations للصور المتزامنة فقط — لا مهام غير متزامنة
  async createTask() {
    throw new ProviderHttpError("مزود Pollinations يعيد رابط الصورة فورًا — لا مهام غير متزامنة", 501);
  },

  async checkTask() {
    // لا تُستدعى أبدًا لمهام الصور المتزامنة (تكتمل فورًا) — احتياط للأمان فقط
    return { status: "failed", error: "مزود Pollinations لا يوفر استعلام مهام — المهمة متزامنة تكتمل فورًا" };
  },
};
