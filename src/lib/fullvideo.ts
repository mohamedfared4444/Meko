import { randomUUID } from "node:crypto";
import { classifyProviderError } from "./errors";
import { mergerConfigured, mergerVideocut, MergerError } from "./merger";
import { findModel } from "./models";
import { geminiGenerateJson } from "./providers/gemini";
import { getAdapter } from "./providers/registry";
import type { ApiKeyRow, MediaType, ModelDef, TaskRow } from "./types";
import { candidatePool, maxWaitSeconds } from "./coordinator";
import { generateVoiceover, normalizeVoice, sanitizePitch, sanitizeRate } from "./tts";
import { getTask, getKeyPool, insertTask, recordKeyUsage, updateTask } from "./turso";

/**
 * خط إنتاج الفيديو الأوتوماتيكي الشامل — create_full_video:
 *  1) السكربت: إما سكربت جاهز من العميل (custom_script) يُستخدم حرفيًا للصوت
 *     مع برومبتات مشاهد جاهزة (scenes) أو تُولَّد من جُمَله بـ Gemini — أو
 *     Gemini (gemini-2.5-flash، JSON منظّم) يكتب نص التعليق + يقسّم المشاهد
 *     + يكتب برومبت صورة موحّد الشخصية والستايل لكل مشهد، بسقف كلمات دقيق
 *     من المدة المطلوبة (ar ‎2.1 كلمة/ث، en ‎2.5 كلمة/ث) وبتعليمات صارمة
 *     ضد التكرار والجمل الإنشائية العامة.
 *     (بلا مفاتيح Gemini أو عند فشلها: سكربت احتياطي محلي يبني المشاهد من
 *     الموضوع — الخط لا يتوقف أبدًا في هذه الخطوة.)
 *  2) Edge-TTS يولّد الصوت الكامل (MP3) وتُحسب مدته الدقيقة بالثواني،
 *     مع توقيتات كل كلمة (WordBoundary/SentenceBoundary) لبناء ترجمة
 *     SRT متزامنة مجانًا من نفس النداء.
 *  3) صور المشاهد تُولَّد بالتسلسل عبر مجمع المفاتيح المجاني بالترتيب
 *     (Cloudflare → Hugging Face → Gemini Imagen → Pollinations → kie → CometAPI)
 *     مع تسجيل استخدام المفاتيح وتصنيف الأخطاء — وكل صورة تُخزَّن فور اكتمالها
 *     (قابل للاستكمال بعد أي انقطاع).
 *  4) الصور + الصوت + ملف الترجمة يُرسلون إلى خدمة meko-manger (/api/videocut)
 *     لدمجهما عبر FFmpeg بحركة كاميرا Ken Burns وانتقالات Crossfade ومدة مطابقة
 *     للصوت وطباعة الترجمة على الفيديو (captions: true افتراضيًا) —
 *     فيديو MP4 نهائي برابط مباشر.
 *
 * آلة حالات قابلة للاستكمال: كل خطوة تحفظ تقدمها في params_json للمهمة نفسها
 * (task_id واحد للمشروع كله)، ونسبة التقدم تُحدَّث في لوحة المهام بعد كل
 * خطوة: سكربت 10% → صوت 20% → صور 20–80% → دمج 85–95% → مكتمل 100%.
 * استدعاء get_task يكمل من حيث توقف — لا تضيع أي خطوة منفذة.
 */

/** معرّف الموديل للمهام الكاملة (يفرّق عن توليد الفيديو العادي في refreshTask) */
export const FULL_VIDEO_MODEL = "full-video-pipeline";

const PIPELINE_BUDGET_MS = 45_000; // أقل من حد Vercel 60 ثانية بهامش آمن
const MIN_ACTION_BUDGET_MS = 8_000; // أقل ميزانية تسمح ببدء خطوة شبكية جديدة
const MERGE_MIN_BUDGET_MS = 25_000; // الدمج المتزامن يحتاج نافذة كاملة تقريبًا

const MIN_DURATION = 10;
const MAX_DURATION = 180;
const SCENE_MIN = 3;
const SCENE_MAX = 12;
/** ثانية تقريبًا لكل كلمة في النطق الطبيعي — السقف الدقيق الذي حدده المستخدم:
 *  العربية ‎2.1 كلمة/ثانية والإنجليزية ‎2.5 كلمة/ثانية */
const WORDS_PER_SEC = { en: 2.5, ar: 2.1 } as const;

export interface FullVideoScene {
  narration: string;
  image_prompt: string;
  image_url?: string;
}

/**
 * حزمة النشر الجاهزة للنسخ (YouTube Shorts / Reels SEO Pack) —
 * تُولَّد باللغة المستهدفة من محتوى السكربت الفعلي وتُعرض مع الفيديو المكتمل.
 */
export interface SeoPack {
  /** ثلاثة عناوين جاذبة مناسبة لـ Shorts/Reels (≤ 70 حرفًا لكل عنوان) */
  titles: string[];
  /** وصف الفيديو الجاهز للنشر مع دعوة للتفاعل (CTA) */
  description: string;
  /** قائمة هاشتاجات مستهدفة جاهزة للنسخ */
  hashtags: string[];
}

export interface FullVideoParams {
  topic: string;
  language: "en" | "ar";
  style: string;
  voice: string;
  aspectRatio: "9:16" | "16:9";
  targetDuration: number;
  /** آلة الحالات: script → audio → images → merge */
  stage: "script" | "audio" | "images" | "merge";
  /** السكربت جاهز ولا حاجة لإعادة الدخول في خطوة السكربت */
  scriptReady?: boolean;
  /** هل السكربت قدمه العميل جاهزًا (custom_script) بدل تأليفه بـ Gemini؟ */
  customScript?: boolean;
  /** تفعيل الترجمة المتزامنة المحروقة (الافتراضي true) */
  captions?: boolean;
  /** رابط ملف الترجمة SRT (http أو data:base64) الناتج من توقيتات Edge-TTS */
  captionsUrl?: string;
  /** هل طُبعت الترجمة فعلاً على الفيديو النهائي؟ (من رد نقطة الدمج) */
  captionsBurned?: boolean;
  /** هل دُمجت موسيقى الخلفية فعلاً في الفيديو النهائي؟ (من رد نقطة الدمج) */
  bgMusicApplied?: boolean;
  /** سرعة النطق المطلوبة من العميل (+5% / -10% …) — تُمرر لـ Edge-TTS */
  voiceRate?: string;
  /** طبقة النبرة المطلوبة من العميل (+0Hz / -2Hz …) — تُمرر لـ Edge-TTS */
  voicePitch?: string;
  /** رابط موسيقى خلفية اختيارية (MP3/WAV) — FFmpeg يكررها/يقصها ويخفضها ويدمجها */
  bgMusicUrl?: string;
  /** حزمة النشر الجاهزة (عناوين + وصف + هاشتاغات) — تُولَّد من السكربت الفعلي */
  seoPack?: SeoPack;
  /** مشاهد بلا تعليق صوتي (scenes فقط) — فيديو صام بمدة الهدف */
  audioSkipped?: boolean;
  title?: string;
  script?: string;
  scenes: FullVideoScene[];
  audioUrl?: string;
  audioDuration?: number;
  videoUrl?: string;
  videoDownloadUrl?: string;
  videoDuration?: number;
  videoJobId?: string;
  /** عدّاد فشل مراكز التقدم للأمان (تجنب الحلقات اللانهائية) */
  failCount: number;
  lastError?: string;
}

function parseParams(task: TaskRow): FullVideoParams | null {
  try {
    const p = JSON.parse(task.params_json) as FullVideoParams;
    return p && p.topic && Array.isArray(p.scenes) ? p : null;
  } catch {
    return null;
  }
}

function saveParams(
  taskId: string,
  params: FullVideoParams,
  extra?: Partial<{ status: TaskRow["status"]; progress: number; error_message: string | null; result_urls_json: string | null }>,
): Promise<unknown> {
  return updateTask(taskId, { params_json: JSON.stringify(params), ...extra });
}

// ---------------------------------------------------------------------------
// 1) السكربت — Gemini أولًا ثم سكربت احتياطي محلي (أو سكربت العميل الجاهز)

function sceneCountFor(durationSec: number): number {
  return Math.max(SCENE_MIN, Math.min(SCENE_MAX, Math.round(durationSec / 6)));
}

/** سقف الكلمات الدقيق للسكربت من المدة المستهدفة (ar ‎2.1 / en ‎2.5 كلمة في الثانية) */
function wordCapFor(durationSec: number, language: "en" | "ar"): number {
  return Math.max(20, Math.round(durationSec * WORDS_PER_SEC[language]));
}

/** تقسيم نص إلى جمل (عربي/إنجليزي) مع إبقاء علامات الترقيم ملتصقة */
export function splitSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?؟…؛])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
  // دمج الشذرات البكرية جدًا في السابقة (أقل من 3 أحرف بعد إزالة الترقيم)
  const merged: string[] = [];
  for (const p of parts) {
    const prev = merged[merged.length - 1];
    if (prev && p.replace(/[.!?؟…؛،:]/g, "").trim().length < 3) merged[merged.length - 1] = `${prev} ${p}`;
    else merged.push(p);
  }
  return merged.length > 0 ? merged : [text.trim()].filter(Boolean);
}

/** توزيع قائمة عناصر على عدد مجموعات بترتيب متصل (لا خلط بين الجمل) */
export function groupEvenly<T>(items: T[], groups: number): T[][] {
  const g = Math.max(1, Math.min(groups, items.length || groups));
  const base = Math.floor(items.length / g);
  const rem = items.length % g;
  const out: T[][] = [];
  let cursor = 0;
  for (let i = 0; i < g; i++) {
    const size = base + (i < rem ? 1 : 0);
    out.push(items.slice(cursor, cursor + size));
    cursor += size;
  }
  return out;
}

/**
 * تطبيق السكربت الجاهز من العميل على المشاهد:
 *  - مشاهد نائبة فارغة (الوضع B): المشاهد تُقاس على عدد الجمل
 *    (سقف SCENE_MAX) وكل مشهد يأخذ جملًا متصلة بالترتيب.
 *  - مشاهد ببرومبتات جاهزة (الوضع A): الجمل توزَّع على المشاهد المعطاة
 *    بالترتيب نفسه وبرومبتات الصور تبقى كما هي دون أي مساس.
 */
export function applyCustomScriptToScenes(
  script: string,
  scenes: FullVideoScene[],
): FullVideoScene[] {
  const sentences = splitSentences(script);
  const allEmpty = scenes.every((s) => !s.image_prompt && !s.narration);
  if (allEmpty) {
    const n = Math.min(SCENE_MAX, Math.max(1, sentences.length));
    return groupEvenly(sentences, n).map((g) => ({ narration: g.join(" "), image_prompt: "" }));
  }
  const groups = groupEvenly(sentences, Math.max(1, scenes.length));
  return scenes.map((s, i) => ({ ...s, narration: (groups[i] ?? []).join(" ") }));
}

/** شكل كائن seo المتوقع من Gemini في برومبت السكربت — حسب لغة السرد */
function seoShapeText(language: "en" | "ar"): string {
  return language === "ar"
    ? `{ "titles": ["عنوان جاذب 1", "عنوان جاذب 2", "عنوان جاذب 3"], "description": "وصف جاهز للنشر من 2–4 جمل يلخص المحتوى الفعلي + سطر دعوة للتفاعل (اشترك/شارك/علّق)", "hashtags": ["#هشتاغ1", "#هشتاغ2"] }`
    : `{ "titles": ["click-worthy title 1", "click-worthy title 2", "click-worthy title 3"], "description": "publish-ready description of 2–4 sentences summarizing the real content + one call-to-action line (subscribe/share/comment)", "hashtags": ["#tag1", "#tag2"] }`;
}

function buildScriptPrompt(params: FullVideoParams): string {
  const n = params.scenes.length;
  const wordCap = wordCapFor(params.targetDuration, params.language);
  const wordsPerScene = Math.max(8, Math.round(wordCap / n));
  const langText =
    params.language === "ar"
      ? `اكتب التعليق الصوتي بالعربية الفصحى المبسطة الجذابة. السقف الصارم: ${wordCap} كلمة كحد أقصى للمسكربت كاملًا (نحو ${wordsPerScene} كلمة لكل مشهد) — عدّ الكلمات قبل أن تكتب.`
      : `Write the voiceover narration in English, conversational and engaging. HARD CAP: the whole script must be AT MOST ${wordCap} words total (about ${wordsPerScene} words per scene) — count words before you output.`;
  const styleText = params.style || (params.language === "ar" ? "سينمائي" : "cinematic");
  const antiFiller =
    params.language === "ar"
      ? [
          `- لا تكرر عنوان الموضوع حرفيًا في أكثر من جملة واحدة، ولا تبدأ بعبارات إنشائية عامة مثل «في هذا الفيديو» أو «دعنا نستكشف» أو «قصة رائعة عن».`,
          `- كل جملة تحمل معلومة حقيقية مركزة (أرقام، أسماء، أسباب، نتائج، تفاصيل ملموسة) أو تدفع سردًا قصصيًا مشوقًا — لا حشو ولا مقدمات فارغة.`,
          `- برومبت الصورة في كل مشهد يصور محتوى الجملة المقابلة له تحديدًا (الأشياء والأماكن والأفعال المذكورة فيها) وليس الموضوع عامة.`,
        ].join("\n")
      : [
          `- Never repeat the topic title verbatim more than once, and never open with generic filler like "In this video", "Let's explore", "Today we'll talk about" or "The amazing story of".`,
          `- Every sentence must carry concrete, focused information (numbers, names, causes, consequences, sensory details) or advance an engaging story — zero filler, zero vague introductions.`,
          `- Each scene's image_prompt must depict the content of ITS corresponding sentence specifically (the objects, places and actions it mentions), not the topic in general.`,
        ].join("\n");
  return `You are a professional short-video scriptwriter for a ${params.targetDuration}-second ${params.aspectRatio} vertical/horizontal video.

Topic: ${params.topic}
Visual style: ${styleText}
${langText}

Write a JSON object with exactly this shape:
{
  "title": "short catchy title (same language as narration)",
  "script": "the full voiceover script as one continuous text",
  "scenes": [
    { "narration": "voiceover line for this scene (~${wordsPerScene} words)", "image_prompt": "detailed text-to-image prompt for this scene" }
  ],
  "seo": ${seoShapeText(params.language)}
}

Rules:
- Exactly ${n} scenes in the "scenes" array.
- Narrations together read as one flowing voiceover of about ${params.targetDuration} seconds. No headings, no bullet points, no stage directions — spoken words only.
- The "seo" object must be built from the ACTUAL script you wrote (same language as the narration): 3 click-worthy titles for YouTube Shorts/Reels (each ≤ 70 characters, curiosity-driven but honest), a publish-ready description of 2–4 sentences summarizing the real content plus one engaging call-to-action line, and 8–12 targeted hashtags mixing broad and niche tags.
${antiFiller}
- EACH image_prompt must: describe ONE consistent main character with an IDENTICAL appearance description repeated word-for-word in every prompt (age, clothing, hair, distinguishing features), keep the SAME art style and color palette across all prompts ("${styleText}" style), be a complete standalone text-to-image prompt with composition, lighting and mood details, and contain NO text/letters/captions inside the image.
- Output JSON only — no markdown fences, no commentary.`;
}

/** برومبت توليد برومبتات الصور فقط لسكربت جاهز من العميل — Gemini لا يُعيد كتابة النص */
function buildImagePromptsPrompt(params: FullVideoParams): string {
  const n = params.scenes.length;
  const styleText = params.style || (params.language === "ar" ? "سينمائي" : "cinematic");
  const sceneList = params.scenes.map((s, i) => `${i + 1}. ${s.narration || params.topic}`).join("\n");
  return `You are a text-to-image prompt engineer. A finished voiceover already exists — DO NOT rewrite, translate or extend it. Your only job: for each numbered scene below, write ONE image prompt depicting exactly what that scene's narration describes (its objects, places, actions, moment in the story).

Topic (context only): ${params.topic}
Visual style: ${styleText}

Scenes (narration is FIXED — it is listed only for you to illustrate):
${sceneList}

Return a JSON object with exactly this shape:
{ "image_prompts": ["prompt for scene 1", "prompt for scene 2", ...] }

Rules:
- Exactly ${n} prompts, in the same order as the scenes.
- Each prompt: ONE consistent main character with an IDENTICAL appearance description repeated word-for-word (age, clothing, hair, distinguishing features), the SAME "${styleText}" art style and color palette, composition + lighting + mood details, and NO text/letters/captions inside the image.
- Output JSON only — no markdown fences, no commentary.`;
}

/** سكربت احتياطي محلي — يعمل بلا أي شبكة، لا يُفشل الخط أبدًا في هذه الخطوة */
function localFallbackScript(params: FullVideoParams): void {
  const n = params.scenes.length;
  const styleText = params.style || (params.language === "ar" ? "سينمائي" : "cinematic");
  const character =
    params.language === "ar"
      ? "بطل رئيسي واحد بمظهر ثابت: شخص بالغ أنيق بسترة كحلية وشعر أسود قصير"
      : "one consistent main character: an elegant adult wearing a navy jacket with short dark hair";
  const narrationLines =
    params.language === "ar"
      ? [
          `هيا نستكشف معًا قصة ${params.topic}.`,
          `${params.topic} موضوع رائع يحمل الكثير من التفاصيل المدهشة.`,
          `كل زاوية في ${params.topic} تكشف عن جانب جديد يستحق التأمل.`,
          `وفي النهاية، يبقى ${params.topic} من القصص التي تستحق أن نتذكرها.`,
        ]
      : [
          `Let's dive into the story of ${params.topic}.`,
          `${params.topic} is a fascinating subject full of surprising details.`,
          `Every angle of ${params.topic} reveals something new worth seeing.`,
          `In the end, ${params.topic} is a story worth remembering.`,
        ];
  params.title = params.language === "ar" ? `قصت ${params.topic}` : `The Story of ${params.topic}`;
  params.script = narrationLines.join(" ");
  for (let i = 0; i < n; i++) {
    const narration = narrationLines[i % narrationLines.length];
    const shot = ["cinematic establishing wide shot", "medium close-up shot", "dynamic panning shot", "dramatic closing wide shot"][i % 4];
    params.scenes[i] = {
      narration,
      image_prompt: `${shot} about ${params.topic}, ${styleText} style, consistent protagonist — ${character}, rich lighting, high detail, no text in image`,
    };
  }
}

/** برومبتات صور احتياطية محلية لسكربت جاهز من العميل — تعكس محتوى كل جملة */
function localScenePrompts(params: FullVideoParams): void {
  const styleText = params.style || (params.language === "ar" ? "سينمائي" : "cinematic");
  const character =
    params.language === "ar"
      ? "بطل رئيسي واحد بمظهر ثابت: شخص بالغ أنيق بسترة كحلية وشعر أسود قصير"
      : "one consistent main character: an elegant adult wearing a navy jacket with short dark hair";
  params.scenes.forEach((s, i) => {
    const shot = ["cinematic establishing wide shot", "medium close-up shot", "dynamic panning shot", "dramatic closing wide shot"][i % 4];
    const about = (s.narration || params.topic).slice(0, 140);
    s.image_prompt = `${shot} illustrating: ${about}. ${styleText} style, consistent protagonist — ${character}, rich lighting, high detail, no text in image`;
  });
}

// ---------------------------------------------------------------------------
// حزمة النشر الجاهزة (SEO Pack) — YouTube Shorts / Reels

/** تنظيف حزمة SEO قادمة من Gemini — null عند الغياب أو التلف */
export function sanitizeSeoPack(raw: unknown): SeoPack | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { titles?: unknown; description?: unknown; hashtags?: unknown };
  const titles = Array.isArray(obj.titles)
    ? (obj.titles as unknown[]).filter((t): t is string => typeof t === "string" && t.trim().length > 2).map((t) => t.trim().slice(0, 95)).slice(0, 3)
    : [];
  const description = typeof obj.description === "string" && obj.description.trim().length > 10 ? obj.description.trim().slice(0, 1200) : "";
  const hashtags = Array.isArray(obj.hashtags)
    ? (obj.hashtags as unknown[])
        .filter((h): h is string => typeof h === "string" && h.trim().length > 1)
        .map((h) => {
          // الهاشتاغ لا يقبل مسافات إطلاقًا — تُحذف كل المسافات وتوحّد البادئة
          const t = h.trim().replace(/^#+/, "").replace(/\s+/g, "");
          return `#${t}`;
        })
        .slice(0, 15)
    : [];
  if (titles.length === 0 || !description || hashtags.length === 0) return null;
  return { titles, description, hashtags };
}

/**
 * حزمة SEO احتياطية محلية — بلا أي شبكة، مبنية على الموضوع والسكربت الفعلي.
 * تعمل لكل اللغات (عربي/إنجليزي) وتضمن أن الحزمة موجودة دائمًا مع الفيديو المكتمل.
 */
export function localSeoPack(params: { topic: string; language: "en" | "ar"; script?: string; title?: string }): SeoPack {
  const topic = params.topic.trim().slice(0, 80);
  const ar = params.language === "ar";
  const baseTitle = (params.title || topic).slice(0, 60);
  const titles = ar
    ? [`${baseTitle} — القصة كاملة`, `لماذا يهمنك ${topic}؟ الحقيقة كاملة`, `${topic}: ما لم تعرفه من قبل`]
    : [`${baseTitle} — The Full Story`, `Why ${topic} Matters More Than You Think`, `${topic}: What Nobody Told You`];
  // الوصف من أول جُمل السكربت الفعلي + دعوة للتفاعل
  const scriptExcerpt = (params.script ?? "").trim().replace(/\s+/g, " ").slice(0, 220);
  const description = ar
    ? `${scriptExcerpt}${scriptExcerpt.length >= 200 ? "…" : ""}\n\nفي هذا الفيديو نأخذك في رحلة سريعة داخل ${topic}. إذا أعجبك المحتوى فاشترك في القناة وفعّل زر الجرس ليصلك كل جديد، وشاركنا رأيك في التعليقات!`
    : `${scriptExcerpt}${scriptExcerpt.length >= 200 ? "…" : ""}\n\nIn this video we take you on a quick journey inside ${topic}. If you enjoyed it, subscribe and hit the bell for more, and tell us what you think in the comments!`;
  // هاشتاغات من كلمات الموضوع المهمة + وسوم المنصات الثابتة
  const stop = new Set(["the", "and", "for", "with", "this", "that", "from", "about", "في", "من", "على", "عن", "الى", "إلى", "مع", "هذا", "هذه", "التي", "الذي"]);
  const words = topic
    .split(/[\s،,.:؛!?؟\-\u0640]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((w) => w.length > 2 && !stop.has(w.toLowerCase()))
    .slice(0, 4);
  const topicTags = words.map((w) => `#${w}`);
  const platformTags = ["#Shorts", "#Reels", "#YouTubeShorts", "#viral", "#fyp", "#explore", "#storytime", "#facts"];
  const hashtags = [...new Set([...topicTags, ...platformTags])].slice(0, 12);
  return { titles: titles.slice(0, 3), description, hashtags };
}

/** برومبت توليد حزمة SEO لسكربت جاهز (الوضعان A/B/C) — يبني على النص الفعلي فقط */
function buildSeoPackPrompt(params: FullVideoParams): string {
  const ar = params.language === "ar";
  const scriptText = (params.script ?? params.scenes.map((s) => s.narration).filter(Boolean).join(" ") ?? "").slice(0, 4000);
  return `You are a YouTube Shorts / Instagram Reels SEO specialist. Based ONLY on the actual voiceover script below, write a publish-ready pack in ${ar ? "Arabic" : "English"}.

Topic: ${params.topic}
Script (FIXED — do not rewrite it):
${scriptText}

Return a JSON object with exactly this shape:
${seoShapeText(params.language)}

Rules:
- Exactly 3 click-worthy titles for Shorts/Reels (each ≤ 70 characters, curiosity-driven but honest, same language as the script).
- description: 2–4 sentences summarizing what the video REALLY says, plus one engaging call-to-action line (subscribe / share / comment).
- 8–12 targeted hashtags mixing broad and niche tags, each starting with #.
- Output JSON only — no markdown fences, no commentary.`;
}

/** اختيار مفتاح gemini نشط مع تدوير + تسجيل استخدام */
async function withGeminiKey<T>(fn: (key: string) => Promise<T>): Promise<T | null> {
  const keys: ApiKeyRow[] = await getKeyPool(["gemini"]).catch(() => []);
  for (const keyRow of keys) {
    try {
      const out = await fn(keyRow.api_key);
      await recordKeyUsage(keyRow.id, { ok: true });
      return out;
    } catch (e) {
      const status = (e as { status?: number }).status;
      const message = e instanceof Error ? e.message : String(e);
      const cls = classifyProviderError(status, message);
      await recordKeyUsage(keyRow.id, { ok: false, error: message, errorClass: cls });
      // مفتاح مرفوض/مستنزف → المفتاح التالي؛ أخطاء params تتوقف
      if (cls === "params") return null;
      continue;
    }
  }
  return null;
}

/**
 * خطوة السكربت — أربعة أوضاع حسب المعطيات:
 *  A) custom_script + scenes: توزيع جمل السكربت الجاهز على المشاهد المعطاة
 *     بالترتيب (بلا أي شبكة) — الصوت يُولَّد من النص كما هو حرفيًا.
 *  B) custom_script فقط: Gemini يكتب برومبتات الصور فقط من جمل السكربت
 *     (لا يُعيد كتابة النص إطلاقًا) — وفشلها برومبتات محلية احتياطية.
 *  C) scenes فقط: صور بالبرومبتات المعطاة، بلا تعليق صوتي (فيديو صام).
 *  D) بلا معطيات: Gemini يكتب السكربت والمشاهد كاملة (السلوك الأصلي).
 */
/**
 * ضمان وجود حزمة SEO على المهمة:
 *  - الوضع D جاء فيها "seo" من نداء Gemini نفسه — ننقّيها فقط.
 *  - الوضعان A/B/C (سكربت العميل) أو فشل Gemini → نداء صغير مخصص للسكربت الفعلي
 *    (يُتخطى إن كانت نافذة الوقت ضيقة) ← وإلا حزمة محلية بلا شبكة.
 * الحزمة تُبنى دائمًا من محتوى السكربت الفعلي باللغة المستهدفة.
 */
async function ensureSeoPack(taskId: string, params: FullVideoParams, deadline: number): Promise<void> {
  if (params.seoPack) return;
  // نافذة كافية فقط لنداء إضافي — أقل من 12 ثانية نكتفي بالحزمة المحلية فورًا
  if (deadline - Date.now() > 12_000) {
    const viaGemini = await withGeminiKey((key) =>
      geminiGenerateJson(key, buildSeoPackPrompt(params), { timeoutMs: Math.max(6_000, Math.min(12_000, deadline - Date.now())), temperature: 0.7, maxOutputTokens: 1024 }),
    );
    params.seoPack = sanitizeSeoPack(viaGemini?.seo ?? viaGemini) ?? undefined;
  }
  if (!params.seoPack) params.seoPack = localSeoPack(params);
  await saveParams(taskId, params, {});
}

async function ensureScript(taskId: string, params: FullVideoParams, deadline: number): Promise<void> {
  if (params.scriptReady) return;

  // الوضع C — مشاهد جاهزة ببرومبتاتها بلا سكربت: لا شيء يُكتب هنا
  if (!params.customScript && params.scenes.length > 0 && params.scenes.every((s) => s.image_prompt)) {
    if (!params.title) params.title = params.topic.slice(0, 60);
    params.scriptReady = true;
    await ensureSeoPack(taskId, params, deadline);
    await saveParams(taskId, params, { progress: 10, error_message: null });
    return;
  }

  // الوضعان A و B — سكربت جاهز من العميل (custom_script)
  if (params.customScript && params.script) {
    params.scenes = applyCustomScriptToScenes(params.script, params.scenes);
    if (!params.title) params.title = params.topic.slice(0, 60);
    // برومبتات الصور ناقصة (الوضع B) → Gemini يكتبها من الجمل فقط
    if (params.scenes.some((s) => !s.image_prompt)) {
      const viaGemini = await withGeminiKey((key) =>
        geminiGenerateJson(key, buildImagePromptsPrompt(params), { timeoutMs: Math.max(8_000, Math.min(20_000, deadline - Date.now())), temperature: 0.7, maxOutputTokens: 4096 }),
      );
      const prompts = Array.isArray(viaGemini?.image_prompts)
        ? (viaGemini!.image_prompts as unknown[]).filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        : [];
      if (prompts.length === params.scenes.length) {
        params.scenes.forEach((s, i) => {
          s.image_prompt = prompts[i].trim();
        });
      } else {
        localScenePrompts(params);
      }
    }
    params.scriptReady = true;
    await ensureSeoPack(taskId, params, deadline);
    await saveParams(taskId, params, { progress: 10, error_message: null });
    return;
  }

  // الوضع D — السلوك الافتراضي: Gemini يكتب السكربت والمشاهد كاملة
  const n = sceneCountFor(params.targetDuration);
  params.scenes = Array.from({ length: n }, () => ({ narration: "", image_prompt: "" }));

  const viaGemini = await withGeminiKey((key) =>
    geminiGenerateJson(key, buildScriptPrompt(params), { timeoutMs: Math.max(8_000, Math.min(20_000, deadline - Date.now())), temperature: 0.85, maxOutputTokens: 4096 }),
  );

  const scenes = Array.isArray(viaGemini?.scenes) ? ((viaGemini!.scenes as Array<{ narration?: string; image_prompt?: string }>)) : [];
  const valid = scenes.filter((s) => typeof s.narration === "string" && s.narration.trim() && typeof s.image_prompt === "string" && s.image_prompt.trim());
  if (valid.length >= 2) {
    params.title = typeof viaGemini!.title === "string" ? (viaGemini!.title as string) : params.topic;
    params.script = typeof viaGemini!.script === "string" && (viaGemini!.script as string).trim() ? (viaGemini!.script as string) : valid.map((s) => s.narration!.trim()).join(" ");
    params.scenes = valid.slice(0, SCENE_MAX).map((s) => ({ narration: s.narration!.trim(), image_prompt: s.image_prompt!.trim() }));
    // حزمة SEO من نفس نداء Gemini — إن غابت أو تلفت يكملها ensureSeoPack
    params.seoPack = sanitizeSeoPack(viaGemini!.seo) ?? undefined;
  } else {
    localFallbackScript(params);
  }
  params.scriptReady = true;
  await ensureSeoPack(taskId, params, deadline);
  await saveParams(taskId, params, { progress: 10, error_message: null });
}

// ---------------------------------------------------------------------------
// 2) الصوت عبر Edge-TTS

async function ensureAudio(taskId: string, params: FullVideoParams, deadline: number): Promise<void> {
  if (params.audioUrl && params.audioDuration && params.audioDuration > 0) return;
  const narration = params.scenes.map((s) => s.narration).filter(Boolean).join(" ");
  if (!narration) {
    // مشاهد بلا تعليق صوتي (scenes فقط) — فيديو صام بمدة الهدف، بلا ترجمة
    params.audioSkipped = true;
    await saveParams(taskId, params, { progress: 20, error_message: null });
    return;
  }
  const budget = Math.max(10_000, Math.min(30_000, deadline - Date.now()));
  const voice = normalizeVoice(params.voice);
  const wantCaptions = params.captions !== false;
  const out = await generateVoiceover(narration, { voice, rate: params.voiceRate, pitch: params.voicePitch, remainingMs: () => budget, captions: wantCaptions });
  params.audioUrl = out.url;
  params.audioDuration = Math.round(out.durationSec * 100) / 100;
  if (wantCaptions && out.captionsUrl) params.captionsUrl = out.captionsUrl;
  await saveParams(taskId, params, { progress: 20, error_message: null });
}

// ---------------------------------------------------------------------------
// 3) صور المشاهد عبر مجمع المفاتيح المجاني

async function generateSceneImage(model: ModelDef, input: Record<string, unknown>): Promise<{ url: string; keyRow: ApiKeyRow | null }> {
  const pool = await candidatePool(model, undefined);
  let lastError = "لا توجد مفاتيح نشطة لتوليد الصور";
  for (const keyRow of pool) {
    const adapter = getAdapter(keyRow.provider);
    if (!adapter.createImageSync) continue;
    try {
      const { urls } = await adapter.createImageSync(keyRow.api_key, model.providerModel[keyRow.provider], input);
      if (urls?.[0]) {
        await recordKeyUsage(keyRow.id, { ok: true });
        return { url: urls[0], keyRow };
      }
      lastError = "المزود أعاد استجابة بلا روابط";
    } catch (e) {
      const status = (e as { status?: number }).status;
      const message = e instanceof Error ? e.message : String(e);
      const cls = classifyProviderError(status, message);
      await recordKeyUsage(keyRow.id, { ok: false, error: message, errorClass: cls });
      lastError = message;
      if (cls === "params") break;
      continue;
    }
  }
  throw new Error(`تعذر توليد صورة المشهد عبر كل المزودات: ${lastError.slice(0, 220)}`);
}

async function ensureImages(taskId: string, params: FullVideoParams, deadline: number, onProgress: (p: number, msg: string) => Promise<void> | void): Promise<void> {
  const model = findModel("gpt-image-2-6/flare-text-to-image");
  if (!model) throw new Error("موديل الصور غير معروف في السجل");
  const total = params.scenes.length;
  let done = params.scenes.filter((s) => s.image_url).length;

  for (let i = 0; i < total; i++) {
    const scene = params.scenes[i];
    if (scene.image_url) continue;
    if (Date.now() > deadline - MIN_ACTION_BUDGET_MS) {
      // نافذة الوقت تنفد — نحفظ الحالة ونكمل في نداء get_task التالي
      await saveParams(taskId, params, { progress: Math.round(20 + 60 * (done / total)) });
      return;
    }
    const progressBefore = Math.round(20 + 60 * (done / total));
    const progressAfter = Math.round(20 + 60 * ((done + 1) / total));
    await onProgress(progressBefore, `توليد صورة المشهد ${i + 1} من ${total}…`);
    const { url } = await generateSceneImage(model, { prompt: scene.image_prompt, aspect_ratio: params.aspectRatio });
    scene.image_url = url;
    done++;
    await saveParams(taskId, params, { progress: progressAfter, error_message: null });
  }
}

// ---------------------------------------------------------------------------
// 4) الدمج النهائي عبر meko-manger

async function ensureMerge(taskId: string, params: FullVideoParams, deadline: number): Promise<void> {
  if (params.videoUrl) return;
  if (!mergerConfigured()) throw new Error("خدمة الدمج غير مهيأة (MERGER_API_BASE غير مضبوط) — لا يمكن تركيب الفيديو");
  if (Date.now() > deadline - MERGE_MIN_BUDGET_MS) {
    // الدمج يحتاج نافذة كاملة — نحفظ ونتأجل إلى النداء التالي
    await saveParams(taskId, params, { progress: 82, error_message: null });
    return;
  }
  const images = params.scenes.map((s) => s.image_url!).filter(Boolean);
  const useCaptions = params.captions !== false && !!params.captionsUrl;
  const result = await mergerVideocut({
    images,
    audio_url: params.audioUrl ?? null,
    aspect_ratio: params.aspectRatio,
    resolution: params.aspectRatio === "9:16" ? "720p" : "720p",
    // بلا صوت: مدة الهدف تحكم الفيديو الصام
    ...(params.audioUrl ? {} : { total_duration: params.targetDuration }),
    captions_url: useCaptions ? params.captionsUrl! : null,
    // موسيقى خلفية اختيارية — FFmpeg يكررها/يقصها ويخفضها (volume=0.12) ويدمجها amix
    bg_music_url: params.bgMusicUrl ?? null,
  });
  params.videoUrl = result.videoUrl;
  params.videoDownloadUrl = result.downloadUrl;
  params.videoDuration = result.duration;
  params.videoJobId = result.jobId;
  params.stage = "merge";
  params.captionsBurned = result.captions === true;
  params.bgMusicApplied = result.bgMusic === true;
  await saveParams(taskId, params, {
    progress: 100,
    status: "completed",
    result_urls_json: JSON.stringify([result.videoUrl, ...images.slice(0, 12)]),
    error_message: null,
  });
}

// ---------------------------------------------------------------------------
// نافذة التنفيذ + الواجهة العامة

type PipelineOutcome =
  | { kind: "completed" }
  | { kind: "processing"; progress: number }
  | { kind: "failed"; error: string };

/** تقدّم آلة الحالات خطوة واحدة قدر الإمكان ضمن الميزانية الزمنية المتبقية */
async function advancePipeline(
  taskId: string,
  params: FullVideoParams,
  budgetMs: number,
  onProgress: (p: number, msg: string) => Promise<void> | void,
): Promise<PipelineOutcome> {
  const deadline = Date.now() + budgetMs;
  try {
    if (!params.scriptReady) {
      await onProgress(
        3,
        params.customScript ? "تجهيز المشاهد من السكربت الجاهز…" : "كتابة السكربت وتقسيم المشاهد بـ Gemini…",
      );
      await ensureScript(taskId, params, deadline);
    }
    if (!params.audioUrl && !params.audioSkipped) {
      await onProgress(12, params.captions !== false ? "توليد التعليق الصوتي عبر Edge-TTS مع توقيتات الترجمة…" : "توليد التعليق الصوتي عبر Edge-TTS…");
      await ensureAudio(taskId, params, deadline);
    }
    const missingImages = params.scenes.filter((s) => !s.image_url).length;
    if (missingImages > 0) {
      await onProgress(22, `توليد صور المشاهد (${params.scenes.length - missingImages}/${params.scenes.length} مكتملة)…`);
      await ensureImages(taskId, params, deadline, onProgress);
      if (params.scenes.some((s) => !s.image_url)) {
        return { kind: "processing", progress: Math.round(20 + 60 * (params.scenes.filter((s) => s.image_url).length / params.scenes.length)) };
      }
    }
    if (!params.videoUrl) {
      await onProgress(84, "دمج الصور والصوت عبر FFmpeg في خدمة meko-manger…");
      await ensureMerge(taskId, params, deadline);
      if (!params.videoUrl) return { kind: "processing", progress: 82 };
    }
    return { kind: "completed" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    params.failCount = (params.failCount ?? 0) + 1;
    params.lastError = msg.slice(0, 400);
    // خطأ الدمج المعلن من الخدمة نهائي — أما أخطاء الشبكة المؤقتة فتُعاد المحاولة
    // في نداء get_task التالي حتى 3 مرات قبل الفشل النهائي
    const declaredFinal = e instanceof MergerError && e.declared;
    if (declaredFinal || params.failCount >= 3) {
      await saveParams(taskId, params, { status: "failed", error_message: msg.slice(0, 490) });
      return { kind: "failed", error: msg };
    }
    await saveParams(taskId, params, { status: "processing", error_message: `محاولة متعددة (${params.failCount}): ${msg.slice(0, 300)}` });
    return { kind: "processing", progress: Math.max(5, (params.failCount ?? 0) * 3) };
  }
}

/** نص الاكتمال الغني — السكربت + الصور + الصوت + الفيديو في رد واحد */
/** روابط نتيجة المهمة (فيديو + صور) من result_urls_json */
function fullVideoResultUrls(task: TaskRow): string[] {
  try {
    const arr = JSON.parse(task.result_urls_json || "[]") as string[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function formatFullVideoCompleted(task: TaskRow): string {
  const params = parseParams(task);
  if (!params) {
    const urls: string[] = (() => {
      try {
        return JSON.parse(task.result_urls_json || "[]") as string[];
      } catch {
        return [];
      }
    })();
    return `✅ اكتمل فيديو المشروع\n\nالرابط: ${urls[0] ?? "(غير متوفر)"}\n\ntask_id: ${task.id}`;
  }
  const scenesList = params.scenes
    .map((s, i) => `${i + 1}. ${s.image_url ? `[صورة](${s.image_url})` : "(بلا صورة)"} — ${s.narration}`)
    .join("\n");
  const durationLine = params.videoDuration ? `المدة: ${Math.round(params.videoDuration)} ثانية` : params.audioDuration ? `المدة (من الصوت): ${Math.round(params.audioDuration)} ثانية` : "";
  const captionsLine =
    params.audioUrl && params.captions !== false
      ? params.captionsUrl
        ? `💬 الترجمة المتزامنة: ${params.captionsBurned === false ? "طلبت لكنها لم تُطبع" : "مطبوعة داخل الفيديو"} + ملف SRT: ${params.captionsUrl}`
        : "💬 الترجمة المتزامنة: لم تتوفر توقيتات دقيقة من Edge-TTS هذه المرة — الفيديو بلا ترجمة"
      : "";
  const musicLine = params.bgMusicUrl
    ? `🎵 موسيقى الخلفية: ${params.bgMusicApplied === false ? "مرّرت لكنها لم تُدمج" : "مدمجة مع التعليق (خفض تلقائي + تلاشي ختامي)"}`
    : "";
  const voiceLine =
    params.voiceRate || params.voicePitch
      ? `🎚️ الإلقاء: سرعة ${params.voiceRate ?? "+0%"}${params.voicePitch ? ` — نبرة ${params.voicePitch}` : ""}`
      : "";
  const seo = params.seoPack;
  const seoBlock = seo
    ? [
        "🚀 حزمة النشر الجاهزة (YouTube Shorts / Reels SEO):",
        "",
        "📌 عناوين جاذبة (اختر واحدًا):",
        ...seo.titles.map((t, i) => `${i + 1}. ${t}`),
        "",
        "📝 الوصف الجاهز للنشر:",
        seo.description,
        "",
        `#️⃣ الهاشتاغات (انسخها كما هي):\n${seo.hashtags.join(" ")}`,
      ].join("\n")
    : "";
  return [
    "✅ اكتمل خط إنتاج الفيديو بالكامل",
    "",
    `🎬 الفيديو النهائي: ${params.videoUrl ?? "(قيد الدمج)"}`,
    params.videoDownloadUrl ? `⬇️ رابط التحميل: ${params.videoDownloadUrl}` : "",
    durationLine,
    "",
    seoBlock,
    "",
    "🖼️ صور المشاهد:",
    scenesList,
    "",
    params.audioUrl ? `🔊 التعليق الصوتي: ${params.audioUrl}` : "🔕 فيديو صام بلا تعليق صوتي (scenes فقط)",
    "",
    captionsLine,
    musicLine,
    voiceLine,
    "",
    "📜 السكربت:",
    params.script ?? "",
    "",
    `task_id: ${task.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** حد مرور custom_script — يساوي حد Edge-TTS للنص الواحد */
const CUSTOM_SCRIPT_MAX = 6000;
/** حد طول برومبت المشهد الواحد الممرر من العميل */
const CUSTOM_SCENE_MAX_CHARS = 900;
/** حد طول رابط موسيقى الخلفية الممرر */
const BG_MUSIC_URL_MAX = 2048;

/** مدخلات فيديو واحد — أداة create_full_video أو عنصر في batch_create_videos */
export interface FullVideoInput {
  topic: string;
  durationSeconds?: number;
  aspectRatio?: "9:16" | "16:9";
  language?: "en" | "ar";
  style?: string;
  voice?: string;
  /** سكربت التعليق الصوتي الجاهز من العميل — يُستخدم حرفيًا بلا تأليف Gemini */
  customScript?: string;
  /** برومبتات المشاهد الجاهزة من العميل — تُولَّد بالترتيب كما هي */
  scenePrompts?: string[];
  /** ترجمة متزامنة محروقة (افتراضي true) */
  captions?: boolean;
  /** سرعة النطق (+5% / -10% …) — Edge-TTS */
  voiceRate?: string;
  /** طبقة النبرة (+0Hz / -2Hz …) — Edge-TTS */
  voicePitch?: string;
  /** رابط موسيقى خلفية اختيارية (MP3/WAV) — تُدمج عبر FFmpeg في meko-manger */
  bgMusicUrl?: string;
}

/**
 * تحقق وتطبيع مدخلات فيديو واحد — يعيد FullVideoParams جاهزًا للإدراج
 * أو رسالة خطأ عربية واضحة. يُستخدم في create_full_video وbatch_create_videos معًا.
 */
export function buildFullVideoParams(input: FullVideoInput): { ok: true; params: FullVideoParams } | { ok: false; error: string } {
  const topic = (input.topic ?? "").trim();
  if (!topic) return { ok: false, error: "❌ معطيات غير صالحة: الموضوع (topic) مطلوب." };
  if (topic.length > 400) return { ok: false, error: "❌ الموضوع طويل جدًا (الحد 400 حرفًا) — اكتب فكرة الفيديو في جملة أو فقرتين." };
  const aspectRatio = input.aspectRatio ?? "9:16";
  if (!["9:16", "16:9"].includes(aspectRatio)) {
    return { ok: false, error: "❌ معطيات غير صالحة: aspect_ratio يقبل 9:16 أو 16:9 فقط." };
  }
  const language: "en" | "ar" = input.language === "ar" ? "ar" : "en";
  const customScript = (input.customScript ?? "").trim();
  if (customScript.length > CUSTOM_SCRIPT_MAX) {
    return { ok: false, error: `❌ custom_script طويل جدًا (${customScript.length} حرفًا) — الحد ${CUSTOM_SCRIPT_MAX} حرفًا (حد التحويل الصوتي نفسه).` };
  }
  const scenePrompts = (input.scenePrompts ?? [])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean)
    .slice(0, SCENE_MAX)
    .map((s) => s.slice(0, CUSTOM_SCENE_MAX_CHARS));
  if (input.scenePrompts && input.scenePrompts.length > 0 && scenePrompts.length === 0) {
    return { ok: false, error: "❌ scenes ممررة لكنها كلها فارغة — مرّر أوصافًا نصية حقيقية للمشاهد أو احذف المعامل." };
  }
  const bgMusic = (input.bgMusicUrl ?? "").trim();
  if (bgMusic && (bgMusic.length > BG_MUSIC_URL_MAX || !/^(https?:\/\/|data:audio\/)/i.test(bgMusic))) {
    return { ok: false, error: "❌ bg_music_url غير صالح — مرّر رابطًا مباشرًا http/https لملف MP3/WAV (أو data:audio/…)." };
  }
  const durationSeconds = Math.max(MIN_DURATION, Math.min(MAX_DURATION, Math.round(input.durationSeconds || 30)));
  const n = sceneCountFor(durationSeconds);
  // تهيئة المشاهد حسب الوضع:
  //  custom_script + scenes → مشاهد من البرومبتات الجاهزة (الوضع A)
  //  custom_script فقط     → عناصر نائبة تُقاس لاحقًا على عدد الجمل (الوضع B)
  //  scenes فقط            → مشاهد جاهزة بلا صوت (الوضع C)
  //  لا شيء                → عناصر نائبة بعدد المدة القياسي (الوضع D)
  const initialScenes: FullVideoScene[] =
    scenePrompts.length > 0
      ? scenePrompts.map((p) => ({ narration: "", image_prompt: p }))
      : Array.from({ length: n }, () => ({ narration: "", image_prompt: "" }));
  const params: FullVideoParams = {
    topic,
    language,
    style: (input.style ?? "").trim().slice(0, 120),
    voice: normalizeVoice(input.voice),
    aspectRatio,
    targetDuration: durationSeconds,
    stage: "script",
    scenes: initialScenes,
    failCount: 0,
    captions: input.captions !== false,
  };
  const voiceRate = sanitizeRate(input.voiceRate);
  const voicePitch = sanitizePitch(input.voicePitch);
  if (voiceRate) params.voiceRate = voiceRate;
  if (voicePitch) params.voicePitch = voicePitch;
  if (bgMusic) params.bgMusicUrl = bgMusic;
  if (customScript) {
    params.script = customScript;
    params.customScript = true;
  }
  return { ok: true, params };
}

/** التشغيل الأول — أداة create_full_video */
export async function runFullVideo(opts: FullVideoInput & {
  waitSeconds: number;
  onProgress?: (progress: number, message: string) => Promise<void> | void;
}): Promise<
  | { kind: "completed"; taskId: string; urls: string[]; text: string }
  | { kind: "processing"; taskId: string; progress: number; text: string }
  | { kind: "failed"; taskId: string; text: string }
  | { kind: "invalid"; text: string }
> {
  if (!mergerConfigured()) {
    return { kind: "invalid", text: "❌ خدمة الدمج meko-manger غير مهيأة على هذا الخادم (MERGER_API_BASE غير مضبوط) — خط الإنتاج يحتاجها لتركيب الفيديو النهائي." };
  }
  const built = buildFullVideoParams(opts);
  if (!built.ok) return { kind: "invalid", text: built.error };
  const params = built.params;

  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: FULL_VIDEO_MODEL,
    type: "video" as MediaType,
    prompt: params.topic.slice(0, 2000),
    paramsJson: JSON.stringify(params),
    status: "processing",
  });

  const waitSec = Math.max(0, Math.min(opts.waitSeconds, maxWaitSeconds()));
  const outcome = await advancePipeline(taskId, params, Math.min(PIPELINE_BUDGET_MS, waitSec * 1000 || PIPELINE_BUDGET_MS), opts.onProgress ?? (() => {}));

  if (outcome.kind === "completed") {
    const fresh = (await getTask(taskId))!;
    return { kind: "completed", taskId, urls: fullVideoResultUrls(fresh), text: formatFullVideoCompleted(fresh) };
  }
  if (outcome.kind === "failed") {
    const fresh = (await getTask(taskId))!;
    const err = (fresh?.error_message ?? outcome.error ?? "").slice(0, 300);
    return { kind: "failed", taskId, text: `❌ فشل خط الإنتاج: ${err}` };
  }
  const fresh = (await getTask(taskId))!;
  return {
    kind: "processing",
    taskId,
    progress: fresh?.progress ?? outcome.progress,
    text:
      `⏳ خط الإنتاج يعمل — task_id: ${taskId}\n\n` +
      `المرحلة: ${params.videoUrl ? "مكتمل" : params.scenes.every((s) => s.image_url) ? "الدمج النهائي" : "توليد الصور"} — التقدم: ${fresh?.progress ?? outcome.progress}%\n\n` +
      `تابع بـ get_task بنفس المعرّف كل ~10 ثوانٍ حتى الاكتمال (السكربت والصور والصوت محفوظة ولا تُعاد من الصفر).`,
  };
}

// ---------------------------------------------------------------------------
// الإنتاج بالجملة — batch_create_videos

/** حدود الدفعة الواحدة */
const BATCH_MIN = 2;
const BATCH_MAX = 5;

/** عنصر فيديو واحد داخل دفعة batch_create_videos */
export interface BatchVideoItem {
  topic: string;
  customScript?: string;
  scenePrompts?: string[];
}

/**
 * الإنتاج بالجملة — ينشئ 2–5 مهام full-video-pipeline في قاعدة Turso دفعة واحدة
 * بإعدادات مشتركة، ويعيد قائمة أرقام المهام فورًا. جميع المهام تتقدم تلقائيًا
 * في الخلفية (محرك لوحة التحكم يتقدم مهمتين في كل تحديث + get_task لأي مهمة).
 */
export async function runBatchVideos(opts: {
  videos: BatchVideoItem[];
  durationSeconds?: number;
  aspectRatio?: "9:16" | "16:9";
  language?: "en" | "ar";
  style?: string;
  voice?: string;
  captions?: boolean;
  voiceRate?: string;
  voicePitch?: string;
  bgMusicUrl?: string;
}): Promise<{ kind: "created"; taskIds: string[]; text: string } | { kind: "invalid"; text: string } | { kind: "failed"; text: string }> {
  if (!mergerConfigured()) {
    return { kind: "invalid", text: "❌ خدمة الدمج meko-manger غير مهيأة على هذا الخادم (MERGER_API_BASE غير مضبوط) — خط الإنتاج يحتاجها لتركيب الفيديو النهائي." };
  }
  const list = Array.isArray(opts.videos) ? opts.videos : [];
  if (list.length < BATCH_MIN || list.length > BATCH_MAX) {
    return { kind: "invalid", text: `❌ عدد الفيديوهات في الطلب الواحد يجب أن يكون بين ${BATCH_MIN} و${BATCH_MAX} (وصل ${list.length}).` };
  }
  const shared = {
    durationSeconds: opts.durationSeconds,
    aspectRatio: opts.aspectRatio,
    language: opts.language,
    style: opts.style,
    voice: opts.voice,
    captions: opts.captions,
    voiceRate: opts.voiceRate,
    voicePitch: opts.voicePitch,
    bgMusicUrl: opts.bgMusicUrl,
  };
  const taskIds: string[] = [];
  const lines: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = (list[i] ?? {}) as BatchVideoItem;
    const built = buildFullVideoParams({
      ...shared,
      topic: typeof item.topic === "string" ? item.topic : "",
      customScript: typeof item.customScript === "string" ? item.customScript : undefined,
      scenePrompts: Array.isArray(item.scenePrompts) ? item.scenePrompts : undefined,
    });
    if (!built.ok) return { kind: "invalid", text: `❌ العنصر رقم ${i + 1} في videos غير صالح: ${built.error}` };
    const taskId = randomUUID();
    try {
      await insertTask({
        id: taskId,
        model: FULL_VIDEO_MODEL,
        type: "video" as MediaType,
        prompt: built.params.topic.slice(0, 2000),
        paramsJson: JSON.stringify(built.params),
        status: "processing",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const createdNote =
        taskIds.length > 0
          ? `\n\n⚠️ أُنشئت ${taskIds.length} مهام قبل الفشل وهي تعمل فعلاً:\n${taskIds.map((id, k) => `${k + 1}. ${id}`).join("\n")}`
          : "";
      return { kind: "failed", text: `❌ فشل إدراج المهمة رقم ${i + 1} في قاعدة البيانات: ${msg.slice(0, 200)}${createdNote}` };
    }
    taskIds.push(taskId);
    lines.push(`${i + 1}. ${built.params.topic.slice(0, 80)} — task_id: ${taskId}`);
  }
  const settingsLine = [
    `المدة ${shared.durationSeconds ?? 30} ثانية`,
    `الاتجاه ${shared.aspectRatio ?? "9:16"}`,
    `اللغة ${shared.language === "ar" ? "ar" : "en"}`,
    shared.captions === false ? "بلا ترجمة" : "مع ترجمة محروقة",
    shared.voiceRate ? `السرعة ${shared.voiceRate}` : "",
    shared.voicePitch ? `النبرة ${shared.voicePitch}` : "",
    shared.bgMusicUrl ? "مع موسيقى خلفية" : "",
  ]
    .filter(Boolean)
    .join("، ");
  return {
    kind: "created",
    taskIds,
    text:
      `🎬 أُنشئت ${taskIds.length} مهام إنتاج فيديو كامل دفعة واحدة — تتقدم جميعها تلقائيًا في الخلفية وتظهر في لوحة العمل المباشرة\n\n` +
      `الإعدادات المشتركة: ${settingsLine}\n\n` +
      `المهام:\n${lines.join("\n")}\n\n` +
      `تابع أي مهمة بـ get_task بمعرّفها كل ~10 ثوانٍ — والمهام تتقدم أيضًا تلقائيًا بمجرد فتح لوحة التحكم (مهمتان في كل تحديث، بالترتيب).`,
  };
}

/** استكمال مهمة قائمة — أداة get_task */
export async function refreshFullVideoTask(task: TaskRow, onProgress?: (progress: number, message: string) => Promise<void> | void): Promise<
  | { kind: "completed"; taskId: string; urls: string[]; text: string }
  | { kind: "processing"; taskId: string; progress: number; text: string }
  | { kind: "failed"; taskId: string; text: string }
  | { kind: "invalid"; text: string }
> {
  const params = parseParams(task);
  if (!params) {
    await updateTask(task.id, { status: "failed", error_message: "حالة خط الإنتاج تالفة في القاعدة" });
    return { kind: "failed", taskId: task.id, text: "❌ حالة خط الإنتاج تالفة في قاعدة البيانات." };
  }
  if (task.status === "completed") {
    return { kind: "completed", taskId: task.id, urls: fullVideoResultUrls(task), text: formatFullVideoCompleted(task) };
  }
  const outcome = await advancePipeline(task.id, params, PIPELINE_BUDGET_MS, onProgress ?? (() => {}));
  if (outcome.kind === "completed") {
    const fresh = (await getTask(task.id))!;
    return { kind: "completed", taskId: task.id, urls: fullVideoResultUrls(fresh), text: formatFullVideoCompleted(fresh) };
  }
  if (outcome.kind === "failed") {
    const fresh = (await getTask(task.id))!;
    const err = (fresh?.error_message ?? outcome.error ?? "").slice(0, 300);
    return { kind: "failed", taskId: task.id, text: `❌ فشل خط الإنتاج: ${err}` };
  }
  const fresh = (await getTask(task.id))!;
  return {
    kind: "processing",
    taskId: task.id,
    progress: fresh?.progress ?? outcome.progress,
    text: `⏳ خط الإنتاج قيد العمل — التقدم: ${fresh?.progress ?? outcome.progress}%\n\nتابع بـ get_task كل ~10 ثوانٍ.`,
  };
}
