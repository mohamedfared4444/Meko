import { NextResponse } from "next/server";
import { refreshTask } from "@/lib/coordinator";
import { FULL_VIDEO_MODEL } from "@/lib/fullvideo";
import { describeDbError, getTask, listRecentTasks, taskStats, updateTask } from "@/lib/turso";
import type { MediaType, TaskRow, TaskStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * أحدث المهام + الإحصائيات — تستخدمها لوحة المهام في التحديث التلقائي كل 5 ثوانٍ.
 *
 * ميزتان جديدتان تجعلان مهام full-video-pipeline تتقدم وتكتمل تلقائيًا بمجرد
 * فتح لوحة التحكم في المتصفح (بدون الحاجة لنداء get_task عبر MCP):
 *
 * 1) تقدّم تلقائي: كل استدعاء يقدّم حتى مهمتين بحالة processing عبر refreshTask
 *    (نفس محرك get_task تمامًا — آلة حالات قابلة للاستكمال تحفظ كل خطوة في
 *    Turso فلا تُعاد من الصفر). قفل داخل نسخة الخادم يمنع تقدم نفس المهمة في
 *    استدعاءين متداخلين من الواجهة، وترتيب الاختيار الأحدث أولًا يعطي أولوية
 *    للعمل الجاري مشاهده.
 *
 * 2) مهلة قصوى للمهمة (10 دقائق): أي مهمة processing/pending أقدم من 10 دقائق
 *    منذ إنشائها تُفشل تلقائيًا برسالة واضحة — فلا تبقى عالقة على الأبد حتى لو
 *    ماتت الدالة التي كانت تعالجها أو انقطعت الشبكة في منتصف خطوة.
 */

/** المهلة القصوى للمهمة الواحدة — بعدها تُفشل تلقائيًا */
const TASK_MAX_AGE_MS = 10 * 60 * 1000;
/** أقصى عدد مهام جارية تُقدَّم في استدعاء واحد */
const AUTO_REFRESH_LIMIT = 2;
/** رسالة انتهاء المهلة القصوى */
const TIMEOUT_MESSAGE = "انتهت المهلة القصوى للمهمة (10 دقائق) — أُوقفت تلقائيًا حتى لا تبقى عالقة للأبد.";

/** قفل داخل نسخة الخادم: يمنع تقدم نفس المهمة في استدعاءين متداخلين */
const refreshing = new Set<string>();

/** تحليل توقيت Turso «YYYY-MM-DD HH:MM:SS» (UTC) أو ISO إلى epoch ms — NaN عند التعذر */
function parseDbTime(raw: string | null | undefined): number {
  if (!raw) return Number.NaN;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const withZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const t = Date.parse(withZone);
  return Number.isFinite(t) ? t : Number.NaN;
}

/** تفاصيل الخطوات الحية للمهمة — تُعرض في لوحة التحكم مباشرة */
interface TaskDetail {
  /** المرحلة الحالية لخط الإنتاج: script | audio | images | merge */
  stage: string | null;
  /** عدد مشاهد خط الإنتاج الكلي */
  scenesTotal: number | null;
  /** المشاهد المكتملة صورها */
  scenesDone: number | null;
  /** هل اكتمل التعليق الصوتي؟ */
  hasAudio: boolean;
  /** رابط التعليق الصوتي (http أو data URL) */
  audioUrl: string | null;
  /** المزود المستخدم حاليًا (من المهمة نفسها أو آخر محاولة مسجلة) */
  currentProvider: string | null;
  /** آخر ملاحظة/خطأ مسجل على المهمة */
  lastNote: string | null;
}

/** المزود من آخر محاولة في سجل المحاولات */
function lastAttemptProvider(task: TaskRow): string | null {
  try {
    const attempts = JSON.parse(task.attempts_json || "[]") as Array<{ provider?: string }>;
    if (!Array.isArray(attempts) || attempts.length === 0) return null;
    const last = attempts[attempts.length - 1];
    return typeof last?.provider === "string" ? last.provider : null;
  } catch {
    return null;
  }
}

/** بناء تفاصيل حية من params_json لمهام full-video-pipeline (وأساسيات لغيرها) */
function buildDetail(task: TaskRow): TaskDetail {
  const detail: TaskDetail = {
    stage: null,
    scenesTotal: null,
    scenesDone: null,
    hasAudio: false,
    audioUrl: null,
    currentProvider: task.provider ?? lastAttemptProvider(task),
    lastNote: task.error_message,
  };
  if (task.model !== FULL_VIDEO_MODEL) return detail;
  try {
    const p = JSON.parse(task.params_json) as {
      script?: string;
      scenes?: Array<{ image_url?: string }>;
      audioUrl?: string;
      videoUrl?: string;
      stage?: string;
    };
    const scenes = Array.isArray(p.scenes) ? p.scenes : [];
    detail.scenesTotal = scenes.length || null;
    detail.scenesDone = scenes.filter((s) => s.image_url).length || 0;
    detail.hasAudio = !!p.audioUrl;
    detail.audioUrl = p.audioUrl ?? null;
    // المرحلة الفعلية تُشتق من حالة التقدم نفسها (أدق من حقل stage المخزن):
    // فيديو جاهز/كل الصور → الدمج، صوت جاهز → الصور، سكربت جاهز → الصوت، وإلا السكربت
    const allImages = scenes.length > 0 && scenes.every((s) => s.image_url);
    detail.stage = p.videoUrl || allImages ? "merge" : p.audioUrl ? "images" : p.script ? "audio" : "script";
  } catch {
    /* params تالفة — تُعرض الأساسيات فقط */
  }
  return detail;
}

/**
 * 1) فشل تلقائي لأي مهمة تجاوزت المهلة القصوى (10 دقائق).
 * 2) تقدّم تلقائي لأول مهمتين جاريتين غير المقفلتين.
 * تعيد قائمة المهام بعد التقدم (إعادة قراءة واحدة عند حدوث أي تغيير).
 */
async function autoAdvance(
  tasks: TaskRow[],
  reread: () => Promise<TaskRow[]>,
): Promise<{ tasks: TaskRow[]; advanced: number; timedOut: number }> {
  const now = Date.now();
  let timedOut = 0;

  for (const t of tasks) {
    if (t.status !== "processing" && t.status !== "pending") continue;
    const created = parseDbTime(t.created_at);
    if (!Number.isFinite(created) || now - created <= TASK_MAX_AGE_MS) continue;
    try {
      await updateTask(t.id, { status: "failed", error_message: TIMEOUT_MESSAGE });
      t.status = "failed";
      t.error_message = TIMEOUT_MESSAGE;
      timedOut++;
    } catch {
      /* فشل التحديث — نكمل مع البقية */
    }
  }

  const candidates = tasks.filter((t) => t.status === "processing" && !refreshing.has(t.id));
  const picked = candidates.slice(0, AUTO_REFRESH_LIMIT);
  if (picked.length === 0) return { tasks, advanced: 0, timedOut };

  picked.forEach((t) => refreshing.add(t.id));
  try {
    const results = await Promise.allSettled(picked.map((t) => refreshTask(t.id)));
    results.forEach((r) => {
      if (r.status === "rejected") {
        console.error("[tasks:autoAdvance]", r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
    });
  } finally {
    picked.forEach((t) => refreshing.delete(t.id));
  }

  return { tasks: await reread(), advanced: picked.length, timedOut };
}

function taskToResponse(t: TaskRow) {
  let urls: string[] = [];
  let attempts = 0;
  try {
    urls = JSON.parse(t.result_urls_json || "[]") as string[];
  } catch {
    /* تجاهل */
  }
  try {
    attempts = (JSON.parse(t.attempts_json || "[]") as unknown[]).length;
  } catch {
    /* تجاهل */
  }
  return {
    id: t.id,
    type: t.type,
    model: t.model,
    status: t.status,
    progress: t.progress,
    prompt: t.prompt.slice(0, 160),
    urls,
    error: t.error_message,
    attempts,
    created_at: t.created_at,
    updated_at: t.updated_at,
    detail: buildDetail(t),
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 20)));
  const type = (url.searchParams.get("type") || undefined) as MediaType | undefined;
  const status = (url.searchParams.get("status") || undefined) as TaskStatus | undefined;

  try {
    const [initial, initialStats] = await Promise.all([listRecentTasks(limit, { type, status }), taskStats()]);

    const { tasks: advanced, advanced: advancedCount, timedOut } = await autoAdvance(initial, () => listRecentTasks(limit, { type, status }));

    // الإحصائيات بعد التقدم فقط إذا تغير شيء (توفير نداء قاعدة بيانات في الاستدعاءات السريعة)
    const stats = advancedCount > 0 || timedOut > 0 ? await taskStats() : initialStats;

    return NextResponse.json({
      stats,
      meta: { advanced: advancedCount, timedOut },
      tasks: advanced.map(taskToResponse),
    });
  } catch (e) {
    const detail = describeDbError(e);
    console.error("[tasks:GET]", detail);
    return NextResponse.json(
      { stats: { total: 0, completed: 0, failed: 0, processing: 0 }, tasks: [], error: "فشل قراءة المهام من قاعدة البيانات.", detail },
      { status: 503 },
    );
  }
}

/** تفاصيل مهمة واحدة — تُستخدم للعرض الحي عند فتح مهمة محددة من الأرشيف */
export async function POST(req: Request) {
  let body: { id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح — JSON مطلوب." }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "معرّف المهمة (id) مطلوب." }, { status: 400 });
  try {
    const task = await getTask(id);
    if (!task) return NextResponse.json({ error: "لا توجد مهمة بهذا المعرّف." }, { status: 404 });
    return NextResponse.json({ task: { ...taskToResponse(task), prompt: task.prompt } });
  } catch (e) {
    const detail = describeDbError(e);
    console.error("[tasks:POST]", detail);
    return NextResponse.json({ error: "فشل قراءة المهمة.", detail }, { status: 503 });
  }
}
