import { NextResponse } from "next/server";
import { rerenderCodeVideoTask } from "@/lib/codevideo";
import { describeDbError, getTask } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * إعادة رندر مهمة فيديو برمجي من لوحة التحكم — POST { id }:
 * يصفّر الناتج السابق ويُطلق الرندر الكامل FHD 30fps على meko-renderer
 * بمعرّف مهمة دمج جديد، مع إعادة الاستفادة من الصوت والتوقيتات المحفوظة
 * بلا أي إعادة توليد. المهمة تعود للظهور في الشاشة المباشرة فورًا.
 */
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
    const outcome = await rerenderCodeVideoTask(task);
    if (outcome.kind === "invalid") return NextResponse.json({ error: outcome.text }, { status: 400 });
    if (outcome.kind === "failed") return NextResponse.json({ error: outcome.text, task_id: outcome.taskId }, { status: 502 });
    return NextResponse.json({
      ok: true,
      task_id: outcome.taskId,
      status: outcome.kind,
      progress: outcome.kind === "processing" ? outcome.progress : 100,
    });
  } catch (e) {
    const detail = describeDbError(e);
    console.error("[tasks:rerender]", e instanceof Error ? e.message : String(e), detail);
    return NextResponse.json({ error: "فشل إعادة الرندر.", detail }, { status: 503 });
  }
}
