import { NextResponse } from "next/server";
import { z } from "zod";
import { AUTH_DISABLED, bearerOf, resolveSecretKey, secretMatch } from "@/lib/auth";
import { runCodeVideo, rerenderCodeVideoTask } from "@/lib/codevideo";
import { describeDbError, getTask } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * بوابة الأتمتة الموحدة — جاهزة للربط الفوري مع n8n أو أي نظام أتمتة:
 *
 * POST /api/automate/video
 *   Authorization: Bearer <API_KEY>   — من env AUTOMATION_API_KEY أو meta.automation_key (Turso)
 *   { title, script?, voice?, html_code, captions?, caption_style?,
 *     bg_music_url?, webhook_callback_url?, duration_seconds?, aspect_ratio? }
 *   → تُنشئ المهمة وتولّد الصوت والتوقيتات وتطلق الرندر الكامل FHD 30fps
 *     على meko-renderer تلقائيًا، وعند الاكتمال تُرسل خدمة الدمج إشعار POST
 *     إلى webhook_callback_url: { task_id, status, video_url, title }.
 *
 * GET /api/automate/video?task_id=<uuid>
 *   Authorization: Bearer <API_KEY> — استعلام حالة بديل عن الويب هوك (polling).
 *
 * POST { action: "rerender", task_id }
 *   إعادة إطلاق رندر مهمة قائمة (مكتملة أو فاشلة) بنفس الكود والصوت.
 */

/** مهلة الانتظار داخل النداء — تكفي لتوليد الصوت وتخزين الحمولة وإطلاق الـ workflow */
const LAUNCH_WAIT_SECONDS = 42;

const bodySchema = z.object({
  action: z.literal("rerender").optional(),
  task_id: z.string().uuid().optional(),
  title: z.string().min(1, "العنوان (title) مطلوب.").max(200).optional(),
  script: z.string().max(6000).optional(),
  voice: z.string().max(100).optional(),
  html_code: z
    .string()
    .min(100, "html_code قصير جدًا — صفحة HTML كاملة تعرّف window.renderAtTime مطلوبة (100 حرفًا على الأقل).")
    .max(150_000, "html_code أطول من الحد (150000 حرفًا).")
    .optional(),
  captions: z.boolean().optional(),
  // نمط الترجمة الحركية: phrase (مقاطع 2–3 كلمات — افتراضي العامل) أو single-pop
  // (كلمة واحدة كبيرة منبثقة بلا صندوق: أبيض/ذهبي للطويلة >5 أحرف + نبضة تكبير)
  caption_style: z.enum(["phrase", "single-pop"]).optional(),
  bg_music_url: z.string().max(600).optional(),
  webhook_callback_url: z.string().url().max(600).optional(),
  duration_seconds: z.number().int().min(3).max(60).optional(),
  aspect_ratio: z.enum(["9:16", "16:9", "1:1"]).optional(),
});

/** مفتاح البوابة ومقارنته الآمنة — موحّد في @/lib/auth (env أولًا ثم meta.automation_key) */
const resolveApiKey = resolveSecretKey;

function unauthorized(resolved: boolean) {
  return NextResponse.json(
    {
      error: resolved
        ? "مفتاح الأتمتة غير صحيح — مرر الترويسة Authorization: Bearer <API_KEY> بالمفتاح المخزن."
        : "بوابة الأتمتة غير مفعّلة — اضبط AUTOMATION_API_KEY في بيئة Vercel أو خزّن meta.automation_key في Turso أولًا.",
    },
    { status: resolved ? 401 : 503 },
  );
}

export async function POST(req: Request) {
  // بوابة الأتمتة مفتوحة مؤقتًا بطلب صاحب المشروع — راجع AUTH_DISABLED في lib/auth
  if (!AUTH_DISABLED) {
    const apiKey = await resolveApiKey();
    if (!apiKey || !secretMatch(bearerOf(req), apiKey)) return unauthorized(Boolean(apiKey));
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح — JSON مطلوب." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path?.length ? ` (${issue.path.join(".")})` : "";
    return NextResponse.json({ error: `معطيات غير صالحة${field}: ${issue?.message ?? "تحقق من الحقول."}` }, { status: 400 });
  }
  const body = parsed.data;

  // وضع إعادة الرندر: مهمة قائمة بنفس الكود والصوت
  if (body.action === "rerender") {
    if (!body.task_id) return NextResponse.json({ error: "task_id مطلوب مع action=rerender." }, { status: 400 });
    try {
      const task = await getTask(body.task_id);
      if (!task) return NextResponse.json({ error: "لا توجد مهمة بهذا المعرّف." }, { status: 404 });
      const outcome = await rerenderCodeVideoTask(task);
      return automationOutcome(outcome);
    } catch (e) {
      const detail = describeDbError(e);
      console.error("[automate:rerender]", e instanceof Error ? e.message : String(e), detail);
      return NextResponse.json({ error: "فشل إعادة الرندر.", detail }, { status: 503 });
    }
  }

  // الوضع الأساسي: إنشاء مهمة جديدة وإطلاقها
  if (!body.html_code) return NextResponse.json({ error: "html_code مطلوب لإنشاء مهمة جديدة." }, { status: 400 });
  if (!body.title) return NextResponse.json({ error: "title مطلوب لإنشاء مهمة جديدة." }, { status: 400 });

  try {
    const outcome = await runCodeVideo({
      title: body.title,
      htmlCode: body.html_code,
      script: body.script && body.script.trim().length > 0 ? body.script.trim() : undefined,
      voice: body.voice && body.voice.trim().length > 0 ? body.voice.trim() : undefined,
      aspectRatio: body.aspect_ratio,
      durationSeconds: body.duration_seconds,
      captions: body.captions,
      captionStyle: body.caption_style,
      bgMusicUrl: body.bg_music_url && body.bg_music_url.trim().length > 0 ? body.bg_music_url.trim() : undefined,
      webhookCallbackUrl: body.webhook_callback_url && body.webhook_callback_url.trim().length > 0 ? body.webhook_callback_url.trim() : undefined,
      waitSeconds: LAUNCH_WAIT_SECONDS,
    });
    return automationOutcome(outcome);
  } catch (e) {
    const detail = describeDbError(e);
    console.error("[automate:video]", e instanceof Error ? e.message : String(e), detail);
    return NextResponse.json({ error: "فشل تسجيل المهمة في قاعدة البيانات.", detail }, { status: 503 });
  }
}

export async function GET(req: Request) {
  // بوابة الأتمتة مفتوحة مؤقتًا بطلب صاحب المشروع — راجع AUTH_DISABLED في lib/auth
  if (!AUTH_DISABLED) {
    const apiKey = await resolveApiKey();
    if (!apiKey || !secretMatch(bearerOf(req), apiKey)) return unauthorized(Boolean(apiKey));
  }

  const taskId = (new URL(req.url).searchParams.get("task_id") || "").trim();
  if (!taskId) return NextResponse.json({ error: "task_id مطلوب في الاستعلام." }, { status: 400 });
  try {
    const task = await getTask(taskId);
    if (!task) return NextResponse.json({ error: "لا توجد مهمة بهذا المعرّف." }, { status: 404 });
    let videoUrl: string | null = null;
    let title = task.prompt.slice(0, 200);
    try {
      const p = JSON.parse(task.params_json) as { videoUrl?: string; title?: string };
      videoUrl = p.videoUrl ?? null;
      title = p.title ?? title;
    } catch {
      /* params تالفة — نعيد الأساسيات */
    }
    return NextResponse.json({
      ok: true,
      task_id: task.id,
      status: task.status,
      progress: task.progress,
      video_url: videoUrl,
      title,
      error: task.error_message ?? null,
      updated_at: task.updated_at,
    });
  } catch (e) {
    const detail = describeDbError(e);
    console.error("[automate:status]", e instanceof Error ? e.message : String(e), detail);
    return NextResponse.json({ error: "فشل قراءة المهمة.", detail }, { status: 503 });
  }
}

/** تحويل ناتج آلة الحالات إلى استجابة بوابة موحدة */
function automationOutcome(outcome: Awaited<ReturnType<typeof runCodeVideo>>) {
  if (outcome.kind === "invalid") return NextResponse.json({ error: outcome.text }, { status: 400 });
  if (outcome.kind === "failed") return NextResponse.json({ error: outcome.text, task_id: outcome.taskId }, { status: 502 });
  if (outcome.kind === "completed") {
    return NextResponse.json({
      ok: true,
      task_id: outcome.taskId,
      status: "completed",
      video_url: outcome.urls[0] ?? null,
    });
  }
  return NextResponse.json({
    ok: true,
    task_id: outcome.taskId,
    status: "processing",
    progress: outcome.progress,
    status_url: `/api/automate/video?task_id=${outcome.taskId}`,
    note:
      "المهمة أُطلقت — ستصل إشاعة POST إلى webhook_callback_url عند الاكتمال، أو استعلم بـ status_url بنفس الترويسة كل 15 ثانية.",
  });
}
