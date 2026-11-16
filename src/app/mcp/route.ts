import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  listMedia,
  refreshTask,
  runGeneration,
  runMerge,
} from "@/lib/coordinator";
import { runFullVideo } from "@/lib/fullvideo";
import { generateVoiceover, SUPPORTED_VOICES } from "@/lib/tts";
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

const SERVER_INFO = { name: "media-generator-mcp", version: "1.4.0" } as const;

const SERVER_INSTRUCTIONS = `AI media generation server (image: free Cloudflare Workers AI + free Pollinations first, then kie.ai + CometAPI; video: kie.ai + CometAPI — with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
generate_image accepts an optional 'provider' argument (cloudflare | pollinations | kie | cometapi); when omitted the server automatically tries active Cloudflare keys first (free daily allowance), then falls back to Pollinations or kie.ai on any error or exhausted limit.
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.
For a complete automated video from a single topic call create_full_video (topic, duration_seconds, aspect_ratio 9:16|16:9, language en|ar, optional style/voice/custom_script/scenes/captions): it writes the script with Gemini (or uses your ready custom_script verbatim), generates narration audio via free Edge-TTS, generates consistent scene images, and merges everything with Ken Burns motion + crossfades into one MP4 with synchronized captions burned in by default — keep polling get_task until completed; the final response contains the script, all scene images, the audio link, the SRT captions link and the final video link.
Use generate_audio for standalone voiceover MP3s (free Edge-TTS neural voices, English + Arabic, optional rate) — it returns the direct audio URL and exact duration in seconds.`;

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

  // 1) generate_image — توليد صورة: Cloudflare (مجاني) ثم Pollinations (مجاني) ثم kie.ai ثم CometAPI
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image. Supported providers: Cloudflare Workers AI (free daily allowance), Pollinations (fully free, no key) and kie.ai + CometAPI (paid). Default priority tries every ACTIVE Cloudflare key sequentially first, then Pollinations, then kie.ai/CometAPI — automatic failover on any error or exhausted limit. Optional 'provider' argument forces a specific one. Returns the finished image URL if completed within the wait window, otherwise returns a task_id — then call get_task every ~10 seconds until completed, show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z.enum(imageModels as [string, ...string[]]).default("gpt-image-2-6/flare-text-to-image"),
        provider: z
          .enum(["auto", "cloudflare", "huggingface", "gemini", "pollinations", "kie", "kie.ai", "cometapi"])
          .default("auto")
          .describe(
            "Optional provider override. auto = active Cloudflare keys first (free daily allowance, rotated), then Hugging Face (FLUX.1-schnell), then Google Gemini (Imagen), then Pollinations (fully free, no key), then kie.ai/CometAPI (paid). Automatic failover on any error without disabling valid keys.",
          ),
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
          preferredProvider: args.provider,
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
    async (args, extra) => {
      try {
        const outcome = await refreshTask(args.task_id, makeProgressBridge(extra as HandlerExtra));
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

  // 6) generate_audio — تعليق صوتي MP3 مجاني عبر Edge-TTS
  server.registerTool(
    "generate_audio",
    {
      description:
        "Generate a voiceover audio (MP3) from text — free & unlimited via Edge-TTS neural voices. Supports English voices (Andrew, Aria, Guy, Emma, Brian…) and Arabic voices (ar-EG-Shakir, ar-SA-Hamed, ar-EG-Salma) with optional speech rate control. Returns the direct audio URL plus the exact duration in seconds (needed to time scene images for videos).",
      inputSchema: {
        text: z.string().min(1).max(6000).describe("The narration text to speak."),
        voice: z
          .enum(SUPPORTED_VOICES as [string, ...string[]])
          .default("en-US-AndrewNeural")
          .describe("Edge-TTS neural voice. Arabic: ar-EG-ShakirNeural / ar-SA-HamedNeural / ar-EG-SalmaNeural. English: en-US-AndrewNeural (default) / en-US-AriaNeural / en-US-GuyNeural / en-US-EmmaNeural / en-GB-RyanNeural."),
        rate: z
          .string()
          .regex(/^[+-]\d{1,2}%$/)
          .optional()
          .describe("Optional speech rate like '+10%' or '-15%' (clamped to ±50%)."),
      },
    },
    async (args) => {
      try {
        const out = await generateVoiceover(args.text, { voice: args.voice, rate: args.rate });
        return okText(
          `✅ تم توليد الصوت بنجاح\n\nالرابط المباشر: ${out.url}\n\nالمدة بالثواني: ${out.durationSec.toFixed(2)}\nالصوت: ${out.voice}`,
        );
      } catch (e) {
        return errText(`❌ فشل توليد الصوت: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // 7) create_full_video — خط الإنتاج الأوتوماتيكي الشامل
  server.registerTool(
    "create_full_video",
    {
      description:
        "End-to-end automated video pipeline. Give a topic and the server writes the voiceover script with Google Gemini (strict word-count cap matched to duration_seconds: ~2.1 words/sec for Arabic, ~2.5 for English; no repeated titles, no generic filler — real focused narration only), OR pass your finished 'custom_script' to use it verbatim (optionally with ready 'scenes' image prompts used in order). It then generates the narration audio via free Edge-TTS, extracts per-word timings to build synchronized captions (clean SRT, burned into the video by default via FFmpeg), generates every scene image via the free provider chain (Cloudflare → Hugging Face → Gemini Imagen → Pollinations) with a consistent main character and style, then merges images + audio + captions with cinematic Ken Burns camera motion and smooth crossfades (meko-manger) into one MP4 sized exactly to the audio duration. Takes minutes: you get live progress and a task_id — keep calling get_task every ~10 seconds until completed. The final response contains script + scene images + audio link + SRT link + final video link.",
      inputSchema: {
        topic: z.string().min(1).max(400).describe("The video idea or subject, e.g. 'How coffee changed the world' or 'قصة أقدم مكتبة في العالم'. Used as context for scene imagery even when custom_script is passed."),
        custom_script: z
          .string()
          .min(1)
          .max(6000)
          .optional()
          .describe(
            "Ready voiceover script from the caller — used VERBATIM for audio generation with no Gemini scriptwriting. Word count should match the target duration (~2.1 words/sec Arabic, ~2.5 words/sec English). If 'scenes' is omitted, Gemini only splits this script into matching visual scenes (it never rewrites the text).",
          ),
        scenes: z
          .array(z.string().min(1).max(900))
          .min(1)
          .max(12)
          .optional()
          .describe(
            "Ready image prompts (visual scene descriptions) used in order, one image per prompt, no Gemini rewriting. Pass together with custom_script (paired in order with its sentences) or alone (silent Ken Burns video with no voiceover).",
          ),
        duration_seconds: z.number().int().min(10).max(180).default(30).describe("Approximate total video length in seconds (10–180). Controls the Gemini word cap (ar 2.1 / en 2.5 words per second) and silent-video duration.").optional(),
        aspect_ratio: z.enum(["9:16", "16:9"]).default("9:16").describe("9:16 for Shorts/Reels/TikTok, 16:9 for YouTube.").optional(),
        language: z.enum(["en", "ar"]).default("en").describe("Narration language — English (en) or Arabic (ar). Used for the word cap and Gemini prompts when writing a new script.").optional(),
        captions: z
          .boolean()
          .default(true)
          .describe(
            "Burn synchronized auto-captions into the final video (free: Edge-TTS word timings → clean readable SRT with Arabic+English support → FFmpeg burn-in). Default true. Ignored when there is no voiceover audio.",
          )
          .optional(),
        style: z.string().max(120).optional().describe("Visual style for all scenes, e.g. 'cinematic', '3d-animation', 'realistic', 'anime'."),
        voice: z.string().optional().describe("Optional Edge-TTS voice override (e.g. en-US-AriaNeural, ar-EG-ShakirNeural). Defaults: en → en-US-AndrewNeural, ar → ar-EG-ShakirNeural."),
        wait_seconds: z.number().int().min(0).max(240).default(45).describe("How long to wait in this call before returning a task_id.").optional(),
      },
    },
    async (args, extra) => {
      try {
        const outcome = await runFullVideo({
          topic: args.topic,
          durationSeconds: args.duration_seconds ?? 30,
          aspectRatio: args.aspect_ratio ?? "9:16",
          language: args.language ?? "en",
          style: args.style,
          voice: args.voice,
          customScript: args.custom_script,
          scenePrompts: args.scenes,
          captions: args.captions !== false,
          waitSeconds: args.wait_seconds ?? 45,
          onProgress: makeProgressBridge(extra as HandlerExtra),
        });
        if (outcome.kind === "failed" || outcome.kind === "invalid") return errText(outcome.text);
        return okText(outcome.text);
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
