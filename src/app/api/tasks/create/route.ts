import { NextResponse } from "next/server";
import { z } from "zod";
import { runFullVideo } from "@/lib/fullvideo";
import { runCodeVideo } from "@/lib/codevideo";
import { describeDbError } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * إطلاق المهام من واجهة الويب مباشرة — نفس دوال التشغيل المسجلة في MCP:
 *  - kind: "full" → runFullVideo (أداة create_full_video)
 *  - kind: "code" → runCodeVideo (أداة render_code_video)
 *
 * الانتظار داخل النداء قصير عن قصد (8 ثوانٍ): تُسجَّل المهمة في Turso وتُعاد
 * فورًا لتظهر في شاشة العمل المباشر، ثم يتقدمها محرك لوحة التحكم تلقائيًا
 * (refreshTask في GET /api/tasks — كل 5 ثوانٍ) بنفس آلة الحالات القابلة
 * للاستكمال، فلا يُعاد أي عمل من الصفر.
 */

/** مهلة الانتظار القصيرة داخل نداء الإطلاق */
const LAUNCH_WAIT_SECONDS = 8;

const fullSchema = z.object({
  kind: z.literal("full"),
  topic: z.string().min(1, "الموضوع (topic) مطلوب.").max(400),
  custom_script: z.string().max(6000).optional(),
  scenes: z.array(z.string().min(1).max(900)).max(12).optional(),
  duration_seconds: z.number().int().min(10).max(180).optional(),
  aspect_ratio: z.enum(["9:16", "16:9"]).optional(),
  language: z.enum(["en", "ar"]).optional(),
  voice: z.string().max(100).optional(),
  captions: z.boolean().optional(),
});

const codeSchema = z.object({
  kind: z.literal("code"),
  title: z.string().min(1, "عنوان الفيديو (title) مطلوب.").max(200),
  // حد كبير يتسع لأكواد HTML/SVG كاملة من النماذج (150 ألف حرف ≈ كود مشهد غني)
  html_code: z
    .string()
    .min(100, "كود HTML قصير جدًا — الحد الأدنى 100 حرفًا.")
    .max(150_000, "كود HTML طويل جدًا — الحد الأقصى 150000 حرفًا. قسّم المشهد أو اختصر التعليقات."),
  script: z.string().max(6000).optional(),
  voice: z.string().max(100).optional(),
  aspect_ratio: z.enum(["9:16", "16:9", "1:1"]).optional(),
  duration_seconds: z.number().int().min(3).max(60).optional(),
});

const bodySchema = z.discriminatedUnion("kind", [fullSchema, codeSchema]);

/** تنظيف قائمة المشاهد: قص الفراغات وحذف الأسطر الفارغة — وتصبح undefined إن خلت */
function cleanScenes(raw: string[] | undefined): string[] | undefined {
  const list = (raw ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

export async function POST(req: Request) {
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

  try {
    if (body.kind === "full") {
      const outcome = await runFullVideo({
        topic: body.topic,
        customScript: body.custom_script?.trim() || undefined,
        scenePrompts: cleanScenes(body.scenes),
        durationSeconds: body.duration_seconds,
        aspectRatio: body.aspect_ratio,
        language: body.language,
        voice: body.voice && body.voice !== "auto" ? body.voice : undefined,
        captions: body.captions,
        waitSeconds: LAUNCH_WAIT_SECONDS,
      });
      if (outcome.kind === "invalid") return NextResponse.json({ error: outcome.text }, { status: 400 });
      if (outcome.kind === "failed") return NextResponse.json({ error: outcome.text, task_id: outcome.taskId }, { status: 500 });
      return NextResponse.json({ ok: true, kind: "full", task_id: outcome.taskId, status: outcome.kind });
    }

    const outcome = await runCodeVideo({
      title: body.title,
      htmlCode: body.html_code,
      // الحقول الاختيارية الفارغة تصبح undefined قبل التشغيل (لا نص صوتي فارغ)
      script: body.script && body.script.trim().length > 0 ? body.script.trim() : undefined,
      voice: body.voice && body.voice.trim().length > 0 ? body.voice.trim() : undefined,
      aspectRatio: body.aspect_ratio,
      durationSeconds: body.duration_seconds,
      waitSeconds: LAUNCH_WAIT_SECONDS,
    });
    if (outcome.kind === "invalid") {
      return NextResponse.json(
        { error: outcome.text, ...(outcome.taskId ? { task_id: outcome.taskId } : {}) },
        { status: 400 },
      );
    }
    if (outcome.kind === "failed") return NextResponse.json({ error: outcome.text, task_id: outcome.taskId }, { status: 500 });
    return NextResponse.json({ ok: true, kind: "code", task_id: outcome.taskId, status: outcome.kind });
  } catch (e) {
    const detail = describeDbError(e);
    console.error("[tasks:create]", e instanceof Error ? e.message : String(e), detail);
    return NextResponse.json({ error: "فشل تسجيل المهمة في قاعدة البيانات.", detail }, { status: 503 });
  }
}
