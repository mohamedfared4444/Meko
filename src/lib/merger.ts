/**
 * عميل خدمة دمج الفيديو — Video Merger API v2
 * العنوان من MERGER_API_BASE. بلا مفاتيح أو توثيق.
 * قيود مقاسة: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600s مجموع المدد،
 * والملفات تُحذف تلقائيًا بعد 24 ساعة (expiresAt في الاستجابات).
 */

const MAX_JOBS_TIMEOUT_MS = 150_000;

export function mergerBase(): string | null {
  const raw = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");
  if (!raw || raw.includes("xxxxxxxx")) return null;
  return raw;
}

export function mergerConfigured(): boolean {
  return mergerBase() !== null;
}

export class MergerError extends Error {
  status?: number;
  /** هل الخطأ معلن من الخدمة نفسها (HTTP 4xx/5xx بجسم error) = فشل حتمي نهائي؟ */
  declared: boolean;
  constructor(message: string, status?: number, declared = true) {
    super(message);
    this.name = "MergerError";
    this.status = status;
    this.declared = declared;
  }
}

async function mergerFetch(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = mergerBase();
  if (!base) throw new MergerError("خدمة الدمج غير مهيأة (MERGER_API_BASE غير مضبوط)", undefined, false);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { Accept: "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* قد يكون جسمًا غير JSON (مثل ملف فيديو) */
    }
    return { status: res.status, body };
  } catch (e) {
    if (e instanceof MergerError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new MergerError(`انقطع الاتصال بخدمة الدمج (timeout بعد ${timeoutMs}ms)`, undefined, false);
    }
    throw new MergerError(`خطأ شبكة مع خدمة الدمج: ${e instanceof Error ? e.message : String(e)}`, undefined, false);
  } finally {
    clearTimeout(timer);
  }
}

export interface MergerJobCreated {
  jobId: string;
  status: string;
  statusUrl?: string;
  processUrl?: string;
  expiresAt?: string;
}

export interface MergerJobStatus {
  status: "queued" | "uploading" | "processing" | "done" | "failed";
  progress: number; // 0..100 دائمًا (يُضرب في 100 إن جاء كسرًا)
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
}

/** POST /api/jobs — إنشاء مهمة دمج */
export async function mergerCreateJob(videos: string[]): Promise<MergerJobCreated> {
  const { status, body } = await mergerFetch(
    "/api/jobs",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos }) },
    30_000,
  );
  if (status < 200 || status >= 300) {
    const err = typeof body.error === "string" ? body.error : `HTTP ${status}`;
    throw new MergerError(err, status, true);
  }
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  if (!jobId) throw new MergerError("استجابة إنشاء مهمة الدمج بلا jobId", 502, true);
  return {
    jobId,
    status: typeof body.status === "string" ? body.status : "queued",
    statusUrl: typeof body.statusUrl === "string" ? body.statusUrl : undefined,
    processUrl: typeof body.processUrl === "string" ? body.processUrl : undefined,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
  };
}

/**
 * تحليل الحالة دفاعيًا (قسم 7.2):
 * - أكمل: done|completed|complete|success|succeeded|finished
 * - فشل:  error|failed|failure|cancelled — وقد يرد الجسم فيه error بدون status
 * - progress قد يرد كسرًا 0..1 → يُضرب في 100
 */
function parseJobStatus(body: Record<string, unknown>): MergerJobStatus {
  let statusRaw = typeof body.status === "string" ? body.status.toLowerCase() : "";
  const hasError = typeof body.error === "string" && body.error.length > 0;
  if (!statusRaw && hasError) statusRaw = "failed"; // خطأ بلا status → فشل فوري

  let normalized: MergerJobStatus["status"];
  if (/done|completed|complete|success|succeeded|finished/.test(statusRaw)) normalized = "done";
  else if (/error|failed|failure|cancelled/.test(statusRaw) || (hasError && !statusRaw)) normalized = "failed";
  else if (/processing|running|encoding|merging/.test(statusRaw)) normalized = "processing";
  else if (/uploading/.test(statusRaw)) normalized = "uploading";
  else normalized = "queued";

  let progress = typeof body.progress === "number" ? body.progress : 0;
  if (progress > 0 && progress <= 1) progress = progress * 100;
  progress = Math.max(0, Math.min(100, Math.round(progress)));

  const videoUrl = typeof body.videoUrl === "string" ? body.videoUrl : undefined;
  const downloadUrl = typeof body.downloadUrl === "string" ? body.downloadUrl : undefined;
  return { status: normalized, progress, videoUrl, downloadUrl, error: hasError ? (body.error as string) : undefined };
}

/** GET /api/jobs/{id} — الحالة والتقدم */
export async function mergerGetJob(jobId: string): Promise<MergerJobStatus> {
  const { status, body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }, 20_000);
  if (status === 404) {
    throw new MergerError("مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)", 404, true);
  }
  if (status < 200 || status >= 300) {
    const err = typeof body.error === "string" ? body.error : `HTTP ${status}`;
    throw new MergerError(err, status, true);
  }
  return parseJobStatus(body);
}

/**
 * POST /api/jobs/{id}/process — تنفيذ الدمج (يستغرق ~10-15 ثانية، blocking).
 * أي خطأ معلن من الخدمة = فشل حتمي نهائي (لا إعادة محاولة).
 */
export async function mergerProcessJob(jobId: string): Promise<MergerJobStatus> {
  const { status, body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, MAX_JOBS_TIMEOUT_MS);
  if (status === 202) return { status: "processing", progress: 40 };
  if (status < 200 || status >= 300) {
    const err = typeof body.error === "string" ? body.error : `HTTP ${status}`;
    throw new MergerError(err, status, true);
  }
  return parseJobStatus(body);
}

/** DELETE /api/jobs/{id} — حذف فوري (تنظيف اختياري) */
export async function mergerDeleteJob(jobId: string): Promise<void> {
  await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, 15_000);
}

/** رابط النتيجة: فضّل videoUrl ثم downloadUrl، ثم اضبط رابط الفيديو من jobId */
export function mergerResultUrl(base: string, job: { videoUrl?: string; downloadUrl?: string; jobId: string }): string {
  return job.videoUrl || job.downloadUrl || `${base}/api/jobs/${job.jobId}/video`;
}

/** GET /api/config — حدود الخدمة (تُستخدم لفحص الجهوزية) */
export async function mergerHealthy(timeoutMs = 4000): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const { status } = await mergerFetch("/api/config", { method: "GET" }, timeoutMs);
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}
