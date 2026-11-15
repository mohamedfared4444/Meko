import type { MediaType, ModelDef, ProviderId } from "./types";

/**
 * سجل الموديلات — الموديلان المثبّتان من المواصفة + موديل تعديل الصور الذي طلبه
 * المستخدم صراحةً (grok-imagine-image-2-0/segment-edit). أسماء الموديلات لدى كل
 * مزود قابلة للتجاوز بمتغيرات البيئة دون تغيير الكود.
 */
function envModel(envName: string, fallback: string): string {
  const v = process.env[envName];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envModel("KIE_IMAGE_MODEL", "gpt-image-2-6/flare-text-to-image"),
      cometapi: envModel("COMETAPI_IMAGE_MODEL", "gpt-image-2.6-flare-text-to-image"),
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envModel("KIE_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
      cometapi: envModel("COMETAPI_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
    },
  },
  {
    // موديل تعديل صور بالتجزئة (Segment Edit) — يعدّل صورة من مهمة Grok Imagine
    // سابقة عبر task_id + مؤشرات الأقنعة. ليس موديل فيديو كما ذُكر في طلبه الأصلي.
    canonical: "grok-imagine-image-2-0/segment-edit",
    aliases: ["grok-imagine-image-2.0/segment-edit", "grok-imagine-image-2-0/segment-edit"],
    type: "image",
    providers: ["kie"],
    providerModel: {
      kie: envModel("KIE_SEGMENT_EDIT_MODEL", "grok-imagine-image-2.0/segment-edit"),
      cometapi: envModel("COMETAPI_SEGMENT_EDIT_MODEL", "grok-imagine-image-2.0/segment-edit"),
    },
    requiresImageTaskId: true,
  },
];

/** توحيد صيغة الاسم: شرطات بدل النقاط في أرقام الإصدارات + أحرف صغيرة */
export function normalizeModelName(name: string): string {
  return name.trim().toLowerCase().replace(/(\d)\.(\d)/g, "$1-$2");
}

/** إيجاد موديل بالاسم الموحّد — يعيد null إن كان مجهولًا */
export function findModel(name: string): ModelDef | null {
  const n = normalizeModelName(name);
  for (const m of MODELS) {
    if (normalizeModelName(m.canonical) === n) return m;
    if (m.aliases.some((a) => normalizeModelName(a) === n)) return m;
  }
  return null;
}

/** أسماء الموديلات المقبولة في enum أداة generate_image */
export function imageModelEnumValues(): string[] {
  const vals: string[] = [];
  for (const m of MODELS.filter((m) => m.type === "image")) {
    vals.push(m.canonical, ...m.aliases);
  }
  return vals;
}

/** أسماء الموديلات المقبولة في enum أداة generate_video */
export function videoModelEnumValues(): string[] {
  const vals: string[] = [];
  for (const m of MODELS.filter((m) => m.type === "video")) {
    vals.push(m.canonical, ...m.aliases);
  }
  return vals;
}

export function modelByType(type: MediaType): ModelDef[] {
  return MODELS.filter((m) => m.type === type);
}

/** ملخص الموديلات لاستجابة /api/health */
export function modelsSummary(): Array<{ canonical: string; type: MediaType; providers: ProviderId[] }> {
  return MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers }));
}
