import { ProviderHttpError, type ProviderAdapter } from "./types-adapter";

/**
 * مزود kie.ai — Jobs API الموحد (شكل حقيقي مقاس بنداءات فعلية):
 *   POST https://api.kie.ai/api/v1/jobs/createTask
 *     Authorization: Bearer <key>
 *     {"model": "<providerModel>", "input": {...}}
 *     → {"code":200,"msg":"success","data":{"taskId":"..."}}
 *   GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=<id>
 *     → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
 *         "resultJson":"{\"resultUrls\":[\"https://...\"]}",   // نص JSON داخل JSON
 *         "failMsg":"..."}}
 * ملاحظة مقاسة: الخطأ يرد غالبًا بحالة HTTP 200 مع body.code مختلف عن 200
 * (مثال حقيقي: {"code":401,"msg":"Unauthorized – Authentication failed..."}).
 */

const BASE = "https://api.kie.ai";

async function kieFetch(url: string, key: string, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown>> {
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
    const code = typeof body.code === "number" ? body.code : undefined;
    const msg = typeof body.msg === "string" ? body.msg : typeof body.message === "string" ? body.message : text.slice(0, 300);

    // الأخطاء تُرمى بحالة HTTP الفعلية أو code داخل الجسم — أيهما أبلغ
    if (!res.ok) throw new ProviderHttpError(msg || `HTTP ${res.status}`, res.status);
    if (code !== undefined && code !== 200) throw new ProviderHttpError(msg || `code ${code}`, code);
    return body;
  } catch (e) {
    if (e instanceof ProviderHttpError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new ProviderHttpError(`انقطع الاتصال بمزود kie.ai (timeout بعد ${timeoutMs}ms)`, undefined);
    }
    throw new ProviderHttpError(`خطأ شبكة مع مزود kie.ai: ${e instanceof Error ? e.message : String(e)}`, undefined);
  } finally {
    clearTimeout(timer);
  }
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, providerModel, input) {
    const body = await kieFetch(
      `${BASE}/api/v1/jobs/createTask`,
      key,
      { method: "POST", body: JSON.stringify({ model: providerModel, input }) },
      30_000,
    );
    const data = body.data as { taskId?: string } | undefined;
    if (!data?.taskId) throw new ProviderHttpError("استجابة createTask من kie.ai بلا taskId", 502);
    return { providerTaskId: data.taskId };
  },

  async checkTask(key, _providerModel, providerTaskId) {
    const body = await kieFetch(
      `${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      key,
      { method: "GET" },
      25_000,
    );
    const data = (body.data ?? {}) as {
      state?: string;
      resultJson?: string;
      failMsg?: string | null;
      failCode?: number | null;
      response?: { resultUrls?: string[] };
    };

    const state = (data.state ?? "").toLowerCase();

    // استخراج الروابط: resultJson نص JSON داخل JSON — مع احتياط للشكل المباشر
    let urls: string[] = [];
    if (data.resultJson) {
      try {
        const parsed = JSON.parse(data.resultJson) as { resultUrls?: string[]; resultUrl?: string };
        urls = parsed.resultUrls ?? (parsed.resultUrl ? [parsed.resultUrl] : []);
      } catch {
        /* تجاهل */
      }
    }
    if (urls.length === 0 && Array.isArray(data.response?.resultUrls)) {
      urls = data.response.resultUrls;
    }

    if (state === "success") {
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail" || state === "failed") {
      return { status: "failed", error: data.failMsg || "فشل التوليد لدى المزود" };
    }
    // waiting | queuing | generating
    const progress = state === "generating" ? 45 : state === "queuing" ? 12 : 5;
    return { status: "processing", progress };
  },
};
