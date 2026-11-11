import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  listMedia,
  refreshTask,
  runGeneration,
  runMerge,
} from "@/lib/coordinator";
import { imageModelEnumValues, videoModelEnumValues } from "@/lib/models";
import type { MediaType, TaskStatus } from "@/lib/types";

/**
 * خادم MCP على المسار /mcp — نقل Streamable HTTP عبر SDK الرسمي
 * (McpServer + WebStandardStreamableHTTPServerTransport) داخل Next.js
 * App Router. يعمل بوضع Stateless (خادم ونقل جديدان لكل طلب) حتى يعمل
 * بلا مشاكل على Vercel serverless حيث لا توجد ذاكرة جلسات دائمة.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// أقصى مدة دالة على خطة Vercel Hobby — نافذة الانتظار تُقصّ داخليًا عبر MCP_MAX_WAIT_SECONDS
export const maxDuration = 60;

const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// ---------------------------------------------------------------------------
// جسر بث التقدم: progress notifications كل ~3 ثوانٍ عند توفر progressToken

interface HandlerExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
}

function makeProgressBridge(extra: HandlerExtra) {
  const token = extra?._meta?.progressToken;
  return async (progress: number, message: string): Promise<void> => {
    if (!token || !extra?.sendNotification) return;
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total: 100, message },
      });
    } catch {
      // العميل قد لا يقبل بث الإشعارات — نتجاهل بصمت دون إفشال المهمة
    }
  };
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function okText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
function errText(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// ---------------------------------------------------------------------------
// بناء الخادم والأدوات الخمس

const imageModels = imageModelEnumValues();
const videoModels = videoModelEnumValues();

function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // 1) generate_image — توليد صورة بـ gpt-image-2-6/flare-text-to-image
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active keys). Returns the finished image URL if completed within the wait window, otherwise returns a task_id — then call get_task every ~10 seconds until completed, show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z.enum(imageModels as [string, ...string[]]).default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        image_task_id: z
          .string()
          .optional()
          .describe("Only for grok-imagine-image-2-0/segment-edit: task_id of a previous Grok Imagine image task to edit."),
        mask_indexs: z
          .array(z.number())
          .optional()
          .describe("Only for grok-imagine-image-2-0/segment-edit: segment mask indexes to edit."),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      try {
        const outcome = await runGeneration({
          model: args.model ?? "gpt-image-2-6/flare-text-to-image",
          args: {
            prompt: args.prompt,
            aspect_ratio: args.aspect_ratio,
            resolution: args.resolution,
            background: args.background,
            output_format: args.output_format,
            image_task_id: args.image_task_id,
            mask_indexs: args.mask_indexs,
          },
          waitSeconds: args.wait_seconds ?? 90,
          onProgress: makeProgressBridge(extra as HandlerExtra),
        });
        if (outcome.kind === "failed" || outcome.kind === "error" || outcome.kind === "invalid") return errText(outcome.text);
        return okText(outcome.text);
      } catch (e) {
        return errText(`❌ حدث خطأ غير متوقع: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // 2) generate_video — توليد فيديو بـ grok-imagine-video-1-5-preview
  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). Videos take minutes: short wait with live progress streaming, then a task_id — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z.enum(videoModels as [string, ...string[]]).default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true).describe("Native synchronized audio is always generated by the provider."),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      try {
        const outcome = await runGeneration({
          model: args.model ?? "grok-imagine-video-1-5-preview",
          args: {
            prompt: args.prompt,
            image_url: args.image_url,
            aspect_ratio: args.aspect_ratio,
            resolution: args.resolution,
            duration: args.duration,
          },
          waitSeconds: args.wait_seconds ?? 25,
          onProgress: makeProgressBridge(extra as HandlerExtra),
        });
        if (outcome.kind === "failed" || outcome.kind === "error" || outcome.kind === "invalid") return errText(outcome.text);
        return okText(outcome.text);
      } catch (e) {
        return errText(`❌ حدث خطأ غير متوقع: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // 3) merge_videos — دمج عدة مقاطع في فيديو واحد بالترتيب المعطى
  server.registerTool(
    "merge_videos",
    {
      description:
        "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video links) or 'task_ids' (completed video generation tasks — their result URLs are merged in this order; ideal after generating several clips). Merging is usually quick: short wait with progress streaming, then a merge task_id — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      try {
        const outcome = await runMerge({
          urls: args.urls,
          taskIds: args.task_ids,
          waitSeconds: args.wait_seconds ?? 60,
          onProgress: makeProgressBridge(extra as HandlerExtra),
        });
        if (outcome.kind === "failed" || outcome.kind === "error" || outcome.kind === "invalid") return errText(outcome.text);
        return okText(outcome.text);
      } catch (e) {
        return errText(`❌ حدث خطأ غير متوقع: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // 4) get_task — تتبع أي مهمة بمعرّفها (توليد ودمج)
  server.registerTool(
    "get_task",
    {
      description:
        "Track any task by its id — image/video generation AND merging (reads the Turso database and refreshes live from the provider/merging service while in progress). Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().describe("The task_id returned by generate_image, generate_video or merge_videos."),
      },
    },
    async (args) => {
      try {
        const outcome = await refreshTask(args.task_id);
        if (outcome.kind === "failed" || outcome.kind === "invalid" || outcome.kind === "error") return errText(outcome.text);
        return okText(outcome.text);
      } catch (e) {
        return errText(`❌ حدث خطأ غير متوقع: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // 5) list_media — أحدث الوسائط المخزنة بروابطها من قاعدة البيانات
  server.registerTool(
    "list_media",
    {
      description:
        "List the latest images/videos/merges stored with their URLs from the database (no regeneration) — to recall previously generated media.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      try {
        const text = await listMedia({
          type: args.type as MediaType | undefined,
          status: args.status as TaskStatus | undefined,
          limit: args.limit ?? 10,
        });
        return okText(text);
      } catch (e) {
        return errText(`❌ حدث خطأ غير متوقع: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// ربط HTTP

function authOk(req: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  const header = req.headers.get("authorization") || "";
  return header === `Bearer ${token}`;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** زوج خادم/نقل جديد لكل طلب (stateless) — متوافق مع Vercel serverless */
async function handleWithTransport(req: Request): Promise<Response> {
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const cleanup = async () => {
    try {
      await transport.close();
    } catch {
      /* تجاهل */
    }
    try {
      await server.close();
    } catch {
      /* تجاهل */
    }
  };
  req.signal?.addEventListener("abort", () => {
    void cleanup();
  });
  try {
    await server.connect(transport);
    // نُعيد الاستجابة كما هي (قد تكون SSE بثًا حيًا) — التنظيف يتم عند الإلغاء
    return await transport.handleRequest(req);
  } catch (e) {
    await cleanup();
    return jsonError(500, `MCP transport error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!authOk(req)) return jsonError(401, "Unauthorized: missing or invalid Bearer token (MCP_ACCESS_TOKEN)");
  return handleWithTransport(req);
}

export async function GET(req: Request): Promise<Response> {
  if (!authOk(req)) return jsonError(401, "Unauthorized: missing or invalid Bearer token (MCP_ACCESS_TOKEN)");
  return handleWithTransport(req);
}

export async function DELETE(req: Request): Promise<Response> {
  if (!authOk(req)) return jsonError(401, "Unauthorized: missing or invalid Bearer token (MCP_ACCESS_TOKEN)");
  return handleWithTransport(req);
}
