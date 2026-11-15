import { ProviderHttpError, type ProviderAdapter } from "./types-adapter";

/**
 * مزود CometAPI — المزود الثاني:
 * - صور متزامنة عبر نقطة images المتوافقة مع OpenAI (تعيد الرابط فورًا)
 * - فيديو عبر نقطة مهام غير متزامنة بنفس نمط create/check
 * لا مفتاح CometAPI متوفر حاليًا — المحوّل جاهز ويعمل فور إضافة مفتاح من الواجهة.
 * الأشكال محافظة وتتبع نمط OpenAI/CometAPI المعلن؛ أي استجابة غير متوقعة تُرمى
 * كـ ProviderHttpError لتُصنَّف في الجدول الموحد.
 */

const BASE = process.env.COMETAPI_BASE_URL?.replace(/\/+$/, "") || "https://api.cometapi.com";

async function cometFetch(url: string, key: string, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* جسم غير JSON */
    }
    if (!res.ok) {
      const err = body.error as { message?: string } | undefined;
      throw new ProviderHttpError(err?.message || text.slice(0, 300) || `HTTP ${res.status}`, res.status);
    }
    return body;
  } catch (e) {
    if (e instanceof ProviderHttpError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new ProviderHttpError(`انقطع الاتصال بمزود CometAPI (timeout بعد ${timeoutMs}ms)`, undefined);
    }
    throw new ProviderHttpError(`خطأ شبكة مع مزود CometAPI: ${e instanceof Error ? e.message : String(e)}`, undefined);
  } finally {
    clearTimeout(timer);
  }
}

export const cometapiAdapter: ProviderAdapter = {
  // صور متزامنة — OpenAI-compatible: POST /v1/images/generations
  async createImageSync(key, providerModel, input) {
    const body = await cometFetch(
      `${BASE}/v1/images/generations`,
      key,
      {
        method: "POST",
        body: JSON.stringify({
          model: providerModel,
          prompt: input.prompt,
          ...(typeof input.aspect_ratio === "string" && input.aspect_ratio !== "auto"
            ? { size: openaiSizeFromRatio(input.aspect_ratio) }
            : {}),
          n: 1,
        }),
      },
      120_000,
    );
    const data = body.data as Array<{ url?: string; b64_json?: string }> | undefined;
    const urls: string[] = (data ?? []).map((d) => d.url).filter((u): u is string => !!u);
    if (urls.length === 0) {
      // إن أعاد المزود بيانات مضمنة (b64) لا نستطيع تخزينها كرابط — القاعدة: روابط فقط
      throw new ProviderHttpError("CometAPI أعاد الصورة كبيانات مضمنة (b64_json) بلا رابط مباشر", 502);
    }
    return { urls };
  },

  // فيديو غير متزامن — نقطة المهام بنمط create/check
  async createTask(key, providerModel, input) {
    const body = await cometFetch(
      `${BASE}/v1/videos/generations`,
      key,
      { method: "POST", body: JSON.stringify({ model: providerModel, input }) },
      60_000,
    );
    const taskId =
      (typeof body.task_id === "string" && body.task_id) ||
      (typeof body.id === "string" && body.id) ||
      ((body.data as { task_id?: string } | undefined)?.task_id ?? "");
    if (!taskId) throw new ProviderHttpError("استجابة إنشاء مهمة الفيديو من CometAPI بلا معرّف مهمة", 502);
    return { providerTaskId: taskId };
  },

  async checkTask(key, _providerModel, providerTaskId) {
    const body = await cometFetch(`${BASE}/v1/videos/generations/${encodeURIComponent(providerTaskId)}`, key, { method: "GET" }, 30_000);
    const statusRaw = String(body.status ?? (body.data as { status?: string } | undefined)?.status ?? "").toLowerCase();
    const extractUrls = (): string[] => {
      const d = body.data as { video_url?: string; videoUrl?: string; output?: string[]; results?: string[] } | undefined;
      const out: string[] = [];
      if (typeof d?.video_url === "string") out.push(d.video_url);
      if (typeof d?.videoUrl === "string") out.push(d.videoUrl);
      if (Array.isArray(d?.output)) out.push(...d.output.filter((u): u is string => typeof u === "string"));
      if (Array.isArray(d?.results)) out.push(...d.results.filter((u): u is string => typeof u === "string"));
      if (typeof body.video_url === "string") out.push(body.video_url);
      return Array.from(new Set(out));
    };
    if (["succeeded", "success", "completed", "done"].includes(statusRaw)) {
      return { status: "completed", urls: extractUrls(), progress: 100 };
    }
    if (["failed", "error", "cancelled"].includes(statusRaw)) {
      const err = body.error as { message?: string } | undefined;
      return { status: "failed", error: err?.message || "فشل التوليد لدى CometAPI" };
    }
    return { status: "processing", progress: statusRaw === "processing" ? 45 : 12 };
  },
};

/** تحويل نسبة الأبعاد إلى أقرب مقاس OpenAI (للصور المتزامنة فقط) */
function openaiSizeFromRatio(ratio: string): string | undefined {
  const map: Record<string, string> = {
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
    "16:9": "1792x1024",
    "9:16": "1024x1792",
  };
  return map[ratio];
}
