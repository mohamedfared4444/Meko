import { randomUUID } from "node:crypto";
import type { WordTiming } from "./captions";
import { mergerCodeVideo, mergerConfigured, mergerStoreRenderPayload, MergerError } from "./merger";
import { synthesizeSpeech, normalizeVoice } from "./tts";
import { uploadViaHosts } from "./upload";
import { getMeta, getTask, insertTask, updateTask } from "./turso";
import { sanitizeEnvValue } from "@/lib/env";
import type { MediaType, TaskRow } from "./types";

/**
 * خط إنتاج فيديو الأنيميشن البرمجي (Code-Driven 2D Vector Motion Graphics):
 * Claude يكتب مشهدًا كاملًا (HTML5 + SVG/Canvas + JS) يعرّف الدالة العالمية
 * `window.renderAtTime(t, duration, wordTimings)` لرسم حالة المشهد بدقة في أي
 * لحظة زمنية، وMeko يحوّله إلى فيديو MP4 على meko-manger:
 *
 *  1) صوت اختياري (script): Edge-TTS يولّد التعليق ويستخرج توقيتات كل كلمة
 *     من نفس النداء — ومدة الفيديو تُضبط تلقائيًا على مدة الصوت الفعلية.
 *  2) الرندر الكامل (المسار الأساسي عند توفر GITHUB_TOKEN): تُخزّن الحمولة
 *     (الكود + الصوت + التوقيتات) على خدمة الدمج ثم يُطلق workflow
 *     render-code-video.yml على GitHub Actions — عامل ubuntu يرندر كل
 *     الإطارات بمعدل 30fps ثابت وبأبعاد FHD كاملة (1080×1920) بلا أي تخفيض
 *     أو مهلة، يرفع MP4 إلى meko-manger ويحدّث المهمة في Turso
 *     (status=completed, progress=100, video_url=…) مباشرة.
 *  3) الرندر الاحتياطي (بلا توكن): نقطة /api/codevideo في meko-manger تفتح
 *     الصفحة بـ Chromium (puppeteer-core + @sparticuz/chromium) وتلتقط إطارًا
 *     لكل لحظة t وتمرر wordTimings إلى renderAtTime في كل إطار ثم تضخ
 *     الإطارات عبر stdin في ffmpeg (H.264/yuv420p) — مقاس سريع داخل مهلة الدالة.
 *
 * آلة حالات قابلة للاستكمال مثل full-video-pipeline: كل خطوة تحفظ تقدمها
 * في params_json (task_id واحد)، والتقدم يظهر حيًا في لوحة التحكم:
 * صوت 5–25% → رندر 45–95% → مكتمل 100%. استدعاء get_task يكمل من حيث توقف.
 */

/** معرّف الموديل لمهام الفيديو البرمجي (يميّزها في refreshTask واللوحة) */
export const CODE_VIDEO_MODEL = "code-video-pipeline";

const PIPELINE_BUDGET_MS = 45_000; // أقل من حد Vercel 60 ثانية بهامش آمن
const MIN_ACTION_BUDGET_MS = 12_000; // أقل ميزانية لبدء توليد الصوت
/** الرندر البرمجي متزامن على خدمة الدمج — يحتاج نافذة كاملة قبل البدء (المسار الاحتياطي فقط) */
const CODEVIDEO_MIN_BUDGET_MS = 30_000;
const TTS_TIMEOUT_MS = 40_000;

// ---------------------------------------------------------------------------
// الرندر الكامل على GitHub Actions — FHD 30fps بلا أي تخفيض (خارج مهلة Vercel)

/** المستودع الذي يُطلق عليه workflow الرندر الكامل */
const GH_RENDER_REPO = sanitizeEnvValue(process.env.GH_RENDER_REPO) || "mohamedfared4444/Meko";
/** الفرع المرجعي لإطلاق الـ workflow */
const GH_RENDER_REF = sanitizeEnvValue(process.env.GH_RENDER_REF) || "main";
const GH_WORKFLOW_FILE = "render-code-video.yml";
/** المعدل الثابت الناعم للرندر الكامل — العامل يرندر الإطارات كلها بلا تخفيض */
const GH_RENDER_FPS = 30;
/** حارس ركود: بعد هذا الزمن من الإطلاق بلا نتيجة تُفشل المهمة (مهلة العامل 30 دقيقة + هامش) */
const GH_RENDER_STALE_MS = 40 * 60_000;
/** حد إرسال كود المشهد base64 داخل مدخلات الإطلاق (حد GitHub ~64KB إجمالًا) —
 *  فوقه تُخزَّن الحمولة على خدمة الدمج ويُمرر رابطها payload_url */
const GH_HTML_B64_LIMIT = 40_000;

/**
 * توكن إطلاق GitHub Actions — بيئة Vercel أولًا (GITHUB_TOKEN بصلاحية repo
 * وworkflow، أو GH_RENDER_TOKEN كبديل مسمّى) ثم جدول meta في Turso
 * (المفتاح github_token إن خُزّن من لوحة الإدارة).
 * بلا توكن يعود خط الإنتاج تلقائيًا للرندر السريع على خدمة الدمج.
 */
async function getGitHubToken(): Promise<string | null> {
  const fromEnv = sanitizeEnvValue(process.env.GH_RENDER_TOKEN) || sanitizeEnvValue(process.env.GITHUB_TOKEN);
  if (fromEnv) return fromEnv;
  const stored = await getMeta("github_token");
  return stored ? sanitizeEnvValue(stored) || null : null;
}

/** هل الرندر الكامل على GitHub Actions مُهيّأ (توكن متاح)؟ */
export async function ghRenderEnabled(): Promise<boolean> {
  return (await getGitHubToken()) !== null;
}

/** إطلاق workflow الرندر الكامل — 204 = نجح الإطلاق، غير ذلك فشل حتمي معلن */
async function dispatchRenderWorkflow(token: string, inputs: Record<string, string>): Promise<void> {
  const url = `https://api.github.com/repos/${GH_RENDER_REPO}/actions/workflows/${GH_WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: GH_RENDER_REF, inputs }),
  });
  if (res.status === 204) return;
  const text = await res.text().catch(() => "");
  const hint =
    res.status === 401 || res.status === 403
      ? " — تأكد أن GITHUB_TOKEN صالح وبصلاحية repo/workflow وأن ملف الـ workflow موجود على الفرع المطلوب"
      : res.status === 422
        ? " — ملف الـ workflow غير موجود أو مدخلاته لا تطابق (تأكد من رفع .github/workflows/render-code-video.yml على الفرع)"
        : "";
  throw new MergerError(
    `فشل إطلاق الرندر على GitHub Actions (HTTP ${res.status})${hint}: ${text.slice(0, 200)}`,
    res.status,
    true,
  );
}

/** حدود كود المشهد الواحد (يحمي حجم الجسم 4.5MB وصفوف Turso) */
export const HTML_CODE_MIN = 100;
export const HTML_CODE_MAX = 300_000;
/** حد نص التعليق الصوتي — نفس حد Edge-TTS */
const SCRIPT_MAX = 6000;
const TITLE_MAX = 200;
const DURATION_MIN = 3;
const DURATION_MAX = 60;
const DEFAULT_DURATION = 15;
const DEFAULT_FPS = 20;

/** مقاس الفيديو لكل اتجاه:
 *  - mode "fhd" (الرندر الكامل على GitHub Actions): 1080×1920 / 1920×1080 / 1080×1080 بجودة كاملة
 *  - mode "fast" (الرندر الاحتياطي داخل مهلة Vercel): 540×960 / 960×540 / 640×640
 *    — يقلل بكسلات Chromium Software Rasterizer ~45% فيسرّع الالتقاط */
export function dimensionsFor(aspectRatio: "9:16" | "16:9" | "1:1", mode: "fast" | "fhd" = "fast"): { width: number; height: number } {
  if (mode === "fhd") {
    switch (aspectRatio) {
      case "16:9":
        return { width: 1920, height: 1080 };
      case "1:1":
        return { width: 1080, height: 1080 };
      default:
        return { width: 1080, height: 1920 };
    }
  }
  switch (aspectRatio) {
    case "16:9":
      return { width: 960, height: 540 };
    case "1:1":
      return { width: 640, height: 640 };
    default:
      return { width: 540, height: 960 };
  }
}

export interface CodeVideoParams {
  title: string;
  /** كود المشهد ذاتي الاحتواء — يعرّف window.renderAtTime(t, duration, wordTimings) */
  htmlCode: string;
  /** نص التعليق الصوتي — عند وجوده يُولَّد الصوت أولاً وتزامن الكلمات */
  script?: string;
  voice: string;
  aspectRatio: "9:16" | "16:9" | "1:1";
  width: number;
  height: number;
  fps: number;
  /** مدة الفيديو الصام (بلا script) بالثواني */
  durationSeconds?: number;
  /** آلة الحالات: audio → render */
  stage: "audio" | "render";
  audioUrl?: string;
  audioDuration?: number;
  /** توقيتات الكلمات من Edge-TTS — تُمرر لـ renderAtTime في كل إطار */
  wordTimings?: WordTiming[];
  videoUrl?: string;
  videoDownloadUrl?: string;
  videoDuration?: number;
  videoJobId?: string;
  videoFps?: number;
  videoFrames?: number;
  /** الرندر الكامل: هل أُطلق workflow على GitHub Actions؟ (المهمة تُكمل خارجيًا) */
  renderDispatched?: boolean;
  /** لحظة الإطلاق (ISO) — مدخل حارس الركود */
  dispatchedAt?: string;
  /** معرف مهمة الدمج المرتبط بإطلاق الـ workflow (قدرة تحديث الناتج) */
  ghJobId?: string;
  /** أين رُندر الناتج فعليًا: github-actions | vercel */
  renderHost?: string;
  /** عدّاد فشل مراكز التقدم للأمان */
  failCount: number;
  lastError?: string;
}

function parseParams(task: TaskRow): CodeVideoParams | null {
  try {
    const p = JSON.parse(task.params_json) as CodeVideoParams;
    return p && p.title && typeof p.htmlCode === "string" ? p : null;
  } catch {
    return null;
  }
}

function saveParams(
  taskId: string,
  params: CodeVideoParams,
  extra?: Partial<{ status: TaskRow["status"]; progress: number; error_message: string | null; result_urls_json: string | null }>,
): Promise<unknown> {
  return updateTask(taskId, { params_json: JSON.stringify(params), ...extra });
}

// ---------------------------------------------------------------------------
// التحقق والبناء

export interface CodeVideoInput {
  title: string;
  htmlCode: string;
  script?: string;
  voice?: string;
  aspectRatio?: "9:16" | "16:9" | "1:1";
  /** مدة الفيديو الصام فقط — عند وجود script تكون مدة الصوت هي المرجع */
  durationSeconds?: number;
}

/** تحقق وتطبيع مدخلات الفيديو البرمجي — رسائل عربية واضحة عند الخطأ */
export function buildCodeVideoParams(input: CodeVideoInput): { ok: true; params: CodeVideoParams } | { ok: false; error: string } {
  const title = (input.title ?? "").trim();
  if (!title) return { ok: false, error: "❌ معطيات غير صالحة: عنوان الفيديو (title) مطلوب." };
  if (title.length > TITLE_MAX) return { ok: false, error: `❌ العنوان طويل جدًا (${title.length} حرفًا) — الحد ${TITLE_MAX} حرفًا.` };

  const htmlCode = (input.htmlCode ?? "").trim();
  if (htmlCode.length < HTML_CODE_MIN) {
    return { ok: false, error: `❌ html_code قصير جدًا (${htmlCode.length} حرفًا) — مرّر صفحة HTML/CSS/SVG/JS كاملة ذاتية الاحتواء.` };
  }
  if (htmlCode.length > HTML_CODE_MAX) {
    return { ok: false, error: `❌ html_code طويل جدًا (${htmlCode.length} حرفًا) — الحد ${HTML_CODE_MAX} حرفًا.` };
  }
  if (!/renderAtTime/.test(htmlCode)) {
    return {
      ok: false,
      error: "❌ html_code لا يعرّف renderAtTime — أضف <script> يعرّف window.renderAtTime(t, duration, wordTimings) لرسم حالة المشهد في أي لحظة t.",
    };
  }

  const script = (input.script ?? "").trim();
  if (script.length > SCRIPT_MAX) {
    return { ok: false, error: `❌ script طويل جدًا (${script.length} حرفًا) — الحد ${SCRIPT_MAX} حرفًا (حد التحويل الصوتي نفسه).` };
  }

  const aspectRatio = input.aspectRatio ?? "9:16";
  if (!["9:16", "16:9", "1:1"].includes(aspectRatio)) {
    return { ok: false, error: "❌ aspect_ratio يقبل 9:16 أو 16:9 أو 1:1 فقط." };
  }
  const durationSeconds = Math.max(DURATION_MIN, Math.min(DURATION_MAX, Math.round(input.durationSeconds || DEFAULT_DURATION)));
  const { width, height } = dimensionsFor(aspectRatio);
  const params: CodeVideoParams = {
    title,
    htmlCode,
    voice: normalizeVoice(input.voice),
    aspectRatio,
    width,
    height,
    fps: DEFAULT_FPS,
    durationSeconds,
    stage: "audio",
    failCount: 0,
  };
  if (script) params.script = script;
  return { ok: true, params };
}

// ---------------------------------------------------------------------------
// 1) الصوت — Edge-TTS مع توقيتات الكلمات من نفس النداء

async function ensureAudio(taskId: string, params: CodeVideoParams, deadline: number, onProgress: (p: number, msg: string) => Promise<void> | void): Promise<boolean> {
  if (params.audioUrl && params.audioDuration && params.audioDuration > 0) return true;
  if (!params.script) return true; // لا تعليق صوتي — الرندر الصام مباشرة
  if (Date.now() > deadline - MIN_ACTION_BUDGET_MS) return false; // نافذة ضيقة — أجّل للنداء التالي

  await onProgress(8, "توليد التعليق الصوتي عبر Edge-TTS مع توقيتات الكلمات…");
  const speech = await synthesizeSpeech(params.script, { voice: params.voice, timeoutMs: TTS_TIMEOUT_MS, collectTimings: true });
  const url = await uploadViaHosts(speech.mp3, "audio/mpeg", () => Math.max(0, deadline - Date.now()));
  params.audioUrl = url;
  params.audioDuration = Math.round(speech.durationSec * 100) / 100;
  if (speech.words && speech.words.length >= 2) params.wordTimings = speech.words;
  params.stage = "render";
  await saveParams(taskId, params, { progress: 25, error_message: null });
  return true;
}

// ---------------------------------------------------------------------------
// 2) الرندر — المسار الأساسي: عامل GitHub Actions الكامل (FHD 30fps)؛
//    والاحتياطي بلا توكن: نقطة /api/codevideo في meko-manger (متزامنة حتى ~58 ثانية)

async function ensureRender(taskId: string, params: CodeVideoParams, deadline: number, onProgress: (p: number, msg: string) => Promise<void> | void): Promise<boolean> {
  if (params.videoUrl) return true;

  if (params.renderDispatched) {
    // مُطلق سابقًا على العامل الخارجي — بانتظاره بغض النظر عن توفر التوكن الآن
    // (الرندر الاحتياطي لن يعيد رندل مهمة مُطلقة خارجيًا)، مع حارس ركود يفشلها
    // نهائيًا بعد المهلة
    const at = Date.parse(params.dispatchedAt || "");
    if (Number.isFinite(at) && Date.now() - at > GH_RENDER_STALE_MS) {
      throw new MergerError(
        `تجاوز الرندر الكامل على GitHub Actions مهلة الانتظار (${Math.round(GH_RENDER_STALE_MS / 60000)} دقيقة منذ الإطلاق) — راجع سجل الـ workflow ثم أعد إطلاقه يدويًا بالمعرفين نفسهما إن لزم.`,
        undefined,
        true,
      );
    }
    await saveParams(taskId, params, { progress: 55, error_message: null });
    return false;
  }

  const token = await getGitHubToken();
  if (token) {
    await onProgress(50, "تجهيز الحمولة وإطلاق الرندر الكامل FHD 30fps على GitHub Actions…");
    // أبعاد الجودة الكاملة والمعدل الثابت الناعم — يفرضان حتى على المهام القديمة
    // المُنشئة بأبعاد الرندر السريع كي يخرج العامل دائمًا بـ FHD
    const fhd = dimensionsFor(params.aspectRatio, "fhd");
    params.width = fhd.width;
    params.height = fhd.height;
    params.fps = GH_RENDER_FPS;
    const ghJobId = params.ghJobId ?? params.videoJobId ?? randomUUID();
    params.ghJobId = ghJobId;
    params.renderDispatched = true;
    params.dispatchedAt = new Date().toISOString();

    // كود المشهد يتجاوز حد مدخلات GitHub (~64KB) غالبًا — تُخزّن الحمولة على
    // خدمة الدمج ويُمرر رابطها، وإن تعذر التخزين وكود صغير فيُمرر base64
    const inputs: Record<string, string> = {
      task_id: taskId,
      job_id: ghJobId,
      width: String(params.width),
      height: String(params.height),
      fps: String(GH_RENDER_FPS),
      ...(params.durationSeconds ? { duration: String(params.durationSeconds) } : {}),
      ...(params.audioUrl ? { audio_url: params.audioUrl } : {}),
    };
    let payloadStored = false;
    if (mergerConfigured()) {
      try {
        const stored = await mergerStoreRenderPayload({
          task_id: taskId,
          job_id: ghJobId,
          title: params.title,
          html_code: params.htmlCode,
          audio_url: params.audioUrl ?? null,
          word_timings: params.wordTimings ?? null,
          duration_seconds: params.durationSeconds ?? null,
        });
        inputs.payload_url = stored.payloadUrl;
        payloadStored = true;
      } catch {
        /* تُجرب مسار base64 أدناه */
      }
    }
    if (!payloadStored) {
      if (params.htmlCode.length > GH_HTML_B64_LIMIT) {
        throw new MergerError(
          `تعذر تخزين حمولة المشهد على خدمة الدمج وكوده (${params.htmlCode.length} حرفًا) يتجاوز حد مدخلات الإطلاق (${GH_HTML_B64_LIMIT}) — أعد المحاولة لاحقًا.`,
          undefined,
          true,
        );
      }
      inputs.html_code_b64 = Buffer.from(params.htmlCode, "utf8").toString("base64");
    }

    // احفظ حالة الإطلاق قبل النداء — أي فشل لاحق يصبح مرئيًا على المهمة نفسها
    await saveParams(taskId, params, { progress: 52, error_message: null });
    await dispatchRenderWorkflow(token, inputs);
    return false; // غير متزامن — العامل يكمل المهمة في Turso مباشرة (completed/100/رابط الفيديو)
  }

  // المسار الاحتياطي (بلا توكن): رندر سريع داخل مهلة Vercel كما كان
  if (Date.now() > deadline - CODEVIDEO_MIN_BUDGET_MS) {
    await saveParams(taskId, params, { progress: 45, error_message: null });
    return false;
  }
  await onProgress(50, "رندر إطارات المشهد عبر Chromium ودمجها بـ ffmpeg (رندر سريع — الرندر الكامل FHD يتطلب GITHUB_TOKEN)…");
  const result = await mergerCodeVideo({
    html_code: params.htmlCode,
    audio_url: params.audioUrl ?? null,
    // المدة: مدة الصوت تحكم عند وجودها (الخدمة تكتشفها تلقائيًا) — وإلا المدة المطلوبة
    ...(params.audioUrl ? {} : { duration_seconds: params.durationSeconds ?? DEFAULT_DURATION }),
    fps: params.fps,
    width: params.width,
    height: params.height,
    // التوقيتات تُرسل فقط عند وجودها — لا null (خدمة الدمج ترفض قيمًا غير مصفوفة)
    ...(params.wordTimings ? { word_timings: params.wordTimings } : {}),
  });
  params.videoUrl = result.videoUrl;
  params.videoDownloadUrl = result.downloadUrl;
  params.videoDuration = result.duration;
  params.videoJobId = result.jobId;
  params.videoFps = result.fps;
  params.videoFrames = result.frames;
  params.renderHost = "vercel";
  await saveParams(taskId, params, {
    progress: 100,
    status: "completed",
    result_urls_json: JSON.stringify([result.videoUrl]),
    error_message: null,
  });
  return true;
}

// ---------------------------------------------------------------------------
// آلة الحالات + الواجهة العامة

type PipelineOutcome =
  | { kind: "completed" }
  | { kind: "processing"; progress: number }
  | { kind: "failed"; error: string };

/** تقدّم آلة الحالات خطوة واحدة قدر الإمكان ضمن الميزانية الزمنية المتبقية */
async function advanceCodeVideo(
  taskId: string,
  params: CodeVideoParams,
  budgetMs: number,
  onProgress: (p: number, msg: string) => Promise<void> | void,
): Promise<PipelineOutcome> {
  const deadline = Date.now() + budgetMs;
  try {
    const audioReady = await ensureAudio(taskId, params, deadline, onProgress);
    if (!audioReady) return { kind: "processing", progress: params.videoUrl ? 90 : 20 };

    const rendered = await ensureRender(taskId, params, deadline, onProgress);
    if (!rendered) {
      // في الانتظار: مُطلق على GitHub Actions (55%) أو مؤجل لنافذة ضيقة (45%)
      return { kind: "processing", progress: params.renderDispatched ? 55 : 45 };
    }
    return { kind: "completed" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    params.failCount = (params.failCount ?? 0) + 1;
    params.lastError = msg.slice(0, 400);
    // خطأ الرندر المعلن من الخدمة نهائي — أخطاء الشبكة المؤقتة تُعاد حتى 3 مرات
    const declaredFinal = e instanceof MergerError && e.declared;
    if (declaredFinal || params.failCount >= 3) {
      await saveParams(taskId, params, { status: "failed", error_message: msg.slice(0, 490) });
      return { kind: "failed", error: msg };
    }
    await saveParams(taskId, params, { status: "processing", error_message: `محاولة متعددة (${params.failCount}): ${msg.slice(0, 300)}` });
    return { kind: "processing", progress: Math.max(5, (params.failCount ?? 0) * 3) };
  }
}

function codeVideoResultUrls(task: TaskRow): string[] {
  try {
    const arr = JSON.parse(task.result_urls_json || "[]") as string[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** نص الاكتمال الغني — الفيديو + الصوت + تفاصيل المزامنة في رد واحد */
export function formatCodeVideoCompleted(task: TaskRow): string {
  const params = parseParams(task);
  if (!params) {
    const urls = codeVideoResultUrls(task);
    return `✅ اكتمل فيديو الأنيميشن البرمجي\n\nالرابط: ${urls[0] ?? "(غير متوفر)"}\n\ntask_id: ${task.id}`;
  }
  const lines: string[] = [
    "✅ اكتمل فيديو الأنيميشن البرمجي (Code Video)",
    "",
    `🎬 الفيديو النهائي: ${params.videoUrl ?? "(قيد الرندر)"}`,
    params.videoDownloadUrl ? `⬇️ رابط التحميل: ${params.videoDownloadUrl}` : "",
    params.videoDuration
      ? `⏱️ المدة: ${Math.round(params.videoDuration)} ثانية — الدقة ${params.width}×${params.height}${params.videoFps ? ` — ${params.videoFps}fps (${params.videoFrames} إطارًا)` : ""}`
      : "",
    "",
    params.audioUrl
      ? [
          `🔊 التعليق الصوتي: ${params.audioUrl}`,
          params.wordTimings && params.wordTimings.length > 0
            ? `🎯 مزامنة الكلمات: توقيتات ${params.wordTimings.length} كلمة مُمررة إلى renderAtTime — الأنيميشن يتزامن مع نطق كل كلمة`
            : "🎯 مزامنة الكلمات: لم تتوفر توقيتات دقيقة من Edge-TTS هذه المرة",
          "",
          "📜 نص التعليق:",
          params.script ?? "",
        ].join("\n")
      : "🔕 فيديو صام بلا تعليق صوتي (المشهد يُرندر على المدة المطلوبة)",
    "",
    `task_id: ${task.id}`,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/** التشغيل الأول — أداة render_code_video ونقطة /api/tasks/create */
export async function runCodeVideo(opts: CodeVideoInput & {
  waitSeconds: number;
  onProgress?: (progress: number, message: string) => Promise<void> | void;
}): Promise<
  | { kind: "completed"; taskId: string; urls: string[]; text: string }
  | { kind: "processing"; taskId: string; progress: number; text: string }
  | { kind: "failed"; taskId: string; text: string }
  | { kind: "invalid"; taskId?: string; text: string }
> {
  const built = buildCodeVideoParams(opts);
  const rawTitle = (opts.title ?? "").trim();
  const taskId = randomUUID();

  // المهمة تُسجَّل في Turso فور بدء التشغيل — قبل أي فحص شبكي أو استدعاء خدمة
  // الدمج أو توليد الصوت — حتى تظهر فورًا في شاشة العمل المباشر، ولو فشل
  // الرندر لاحقًا فسبب الفشل مرئي على المهمة نفسها بدل اختفاء الطلب بلا أثر.
  await insertTask({
    id: taskId,
    model: CODE_VIDEO_MODEL,
    type: "video" as MediaType,
    prompt: `فيديو برمجي: ${rawTitle.slice(0, 1900) || "بلا عنوان"}`.slice(0, 2000),
    // فشل التحقق: لا نخزّن الكود الأصلي (قد يكون ضخمًا ويُفشل الإدراج) — الحالة فقط
    paramsJson: JSON.stringify(
      built.ok
        ? built.params
        : { title: rawTitle.slice(0, TITLE_MAX), htmlCode: "", failCount: 1, lastError: built.error.slice(0, 400) } satisfies Partial<CodeVideoParams>,
    ),
    status: "processing",
  });

  if (!built.ok) {
    const err = built.error.slice(0, 490);
    await updateTask(taskId, { status: "failed", error_message: err });
    return { kind: "invalid", taskId, text: built.error };
  }
  const params = built.params;

  if (!mergerConfigured()) {
    const err = "❌ خدمة الدمج meko-manger غير مهيأة على هذا الخادم (MERGER_API_BASE غير مضبوط) — الرندر البرمجي يحتاجها لتحويل المشهد إلى فيديو.";
    await updateTask(taskId, { status: "failed", error_message: err.slice(0, 490) });
    return { kind: "invalid", taskId, text: err };
  }

  const waitSec = Math.max(0, Math.min(opts.waitSeconds, PIPELINE_BUDGET_MS / 1000));
  const outcome = await advanceCodeVideo(taskId, params, Math.min(PIPELINE_BUDGET_MS, waitSec * 1000 || PIPELINE_BUDGET_MS), opts.onProgress ?? (() => {}));

  if (outcome.kind === "completed") {
    const fresh = (await getTask(taskId))!;
    return { kind: "completed", taskId, urls: codeVideoResultUrls(fresh), text: formatCodeVideoCompleted(fresh) };
  }
  if (outcome.kind === "failed") {
    const fresh = (await getTask(taskId))!;
    const err = (fresh?.error_message ?? outcome.error ?? "").slice(0, 300);
    return { kind: "failed", taskId, text: `❌ فشل رندر الفيديو البرمجي: ${err}` };
  }
  const fresh = (await getTask(taskId))!;
  const stage = params.videoUrl ? "الرندر مكتمل" : params.audioUrl || !params.script ? "الرندر البرمجي" : "التعليق الصوتي";
  return {
    kind: "processing",
    taskId,
    progress: fresh?.progress ?? outcome.progress,
    text:
      `⏳ رندر الفيديو البرمجي يعمل — task_id: ${taskId}\n\n` +
      `المرحلة: ${stage} — التقدم: ${fresh?.progress ?? outcome.progress}%\n\n` +
      `تابع بـ get_task بنفس المعرّف كل ~10 ثوانٍ حتى الاكتمال (الكود والصوت والتوقيتات محفوظة ولا تُعاد من الصفر).`,
  };
}

/** استكمال مهمة قائمة — أداة get_task ولوحة التحكم */
export async function refreshCodeVideoTask(task: TaskRow, onProgress?: (progress: number, message: string) => Promise<void> | void): Promise<
  | { kind: "completed"; taskId: string; urls: string[]; text: string }
  | { kind: "processing"; taskId: string; progress: number; text: string }
  | { kind: "failed"; taskId: string; text: string }
  | { kind: "invalid"; text: string }
> {
  const params = parseParams(task);
  if (!params) {
    await updateTask(task.id, { status: "failed", error_message: "حالة الفيديو البرمجي تالفة في القاعدة" });
    return { kind: "failed", taskId: task.id, text: "❌ حالة الفيديو البرمجي تالفة في قاعدة البيانات." };
  }
  if (task.status === "completed") {
    return { kind: "completed", taskId: task.id, urls: codeVideoResultUrls(task), text: formatCodeVideoCompleted(task) };
  }
  const outcome = await advanceCodeVideo(task.id, params, PIPELINE_BUDGET_MS, onProgress ?? (() => {}));
  if (outcome.kind === "completed") {
    const fresh = (await getTask(task.id))!;
    return { kind: "completed", taskId: task.id, urls: codeVideoResultUrls(fresh), text: formatCodeVideoCompleted(fresh) };
  }
  if (outcome.kind === "failed") {
    const fresh = (await getTask(task.id))!;
    const err = (fresh?.error_message ?? outcome.error ?? "").slice(0, 300);
    return { kind: "failed", taskId: task.id, text: `❌ فشل رندر الفيديو البرمجي: ${err}` };
  }
  const fresh = (await getTask(task.id))!;
  return {
    kind: "processing",
    taskId: task.id,
    progress: fresh?.progress ?? outcome.progress,
    text: `⏳ رندر الفيديو البرمجي قيد العمل — التقدم: ${fresh?.progress ?? outcome.progress}%\n\nتابع بـ get_task كل ~10 ثوانٍ.`,
  };
}
