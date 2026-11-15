import { NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";
import type { MediaType, TaskStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** أحدث المهام + الإحصائيات — تستخدمها لوحة المهام في التحديث التلقائي كل 5 ثوانٍ */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 20)));
  const type = (url.searchParams.get("type") || undefined) as MediaType | undefined;
  const status = (url.searchParams.get("status") || undefined) as TaskStatus | undefined;

  const [tasks, stats] = await Promise.all([listRecentTasks(limit, { type, status }), taskStats()]);

  return NextResponse.json({
    stats,
    tasks: tasks.map((t) => {
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
      };
    }),
  });
}
