import { randomUUID } from "node:crypto";
import { classifyProviderError, isKeyOrBalanceRelated, sanitizeErrorForClient } from "./errors";
import { mergerBase, mergerConfigured, mergerCreateJob, mergerGetJob, mergerProcessJob, mergerResultUrl, MergerError } from "./merger";
import { findModel } from "./models";
import { getAdapter } from "./providers/registry";
import type { ApiKeyRow, AttemptRecord, MediaType, ModelDef, ProviderId, TaskRow, TaskStatus } from "./types";
import { getApiKey, getKeyPool, getTask, insertTask, listRecentTasks, recordKeyUsage, updateTask } from "./turso";
import type { ProviderCheckResult } from "./providers/types-adapter";

/**
 * منسق التوليد — قلب المشروع:
 * 1) توحيد اسم الموديل 2) جلب مجمع المفاتيح بترتيب تسلسلي صارم 3) تسجيل المهمة
 * في Turso قبل أي نداء خارجي 4) تجربة المرشحين بالترتيب مع تبديل فوري عند أي
 * خطأ مفتاح/رصيد دون توقف 5) نافذة انتظار ببث تقدم 6) get_task يحدّث حية.
 */

const POLL_INTERVAL_MS = 3000;
const RECREATE_COOLDOWN_MS = 45_000;

/** أقصى نافذة انتظار داخل استدعاء واحد — أقل من حد Vercel (60s) بهامش أمان */
export function maxWaitSeconds(): number {
  const v = Number(process.env.MCP_MAX_WAIT_SECONDS || 45);
  return Number.isFinite(v) && v > 5 && v <= 240 ? v : 45;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ProgressCallback {
  (progress: number, message: string): Promise<void> | void;
}

export type RunOutcome =
  | { kind: "completed"; taskId: string; urls: string[]; text: string }
  | { kind: "processing"; taskId: string; progress: number; text: string }
  | { kind: "failed"; taskId: string; text: string }
  | { kind: "invalid"; text: string } // معطيات تالفة أو لا مفاتيح — قبل إنشاء أي مهمة
  | { kind: "error"; text: string };

function arTypeName(type: MediaType): string {
  return type === "image" ? "صورة" : type === "video" ? "فيديو" : "دمج";
}

function parseParams<T = Record<string, unknown>>(task: TaskRow): T {
  try {
    return JSON.parse(task.params_json) as T;
  } catch {
    return {} as T;
  }
}

function resultUrls(task: TaskRow): string[] {
  try {
    const arr = JSON.parse(task.result_urls_json || "[]") as string[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// بناء مدخلات المزود حسب الموديل (لا نرسل إلا حقول موثقة رسميًا)

function buildProviderInput(
  model: ModelDef,
  args: { prompt: string; aspect_ratio?: string; resolution?: string; background?: string; output_format?: string; image_url?: string; duration?: number },
  rawArgs: Record<string, unknown>,
  resolvedTaskIdMap: Map<string, string>,
): { input: Record<string, unknown>; error?: string } {
  const input: Record<string, unknown> = { prompt: args.prompt };

  if (model.canonical.startsWith("gpt-image")) {
    // GPT Image 2.6 Flare — التوثيق الرسمي: prompt, aspect_ratio, resolution,
    // background (عند 1K فقط), output_format
    if (args.aspect_ratio && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
    if (args.resolution) input.resolution = args.resolution;
    if (args.background && args.background !== "auto" && (args.resolution ?? "1K") === "1K") input.background = args.background;
    if (args.output_format) input.output_format = args.output_format;
    return { input };
  }

  if (model.requiresImageTaskId) {
    // Grok Imagine Image 2.0 Segment Edit — يتطلب task_id لمهمة Grok صور سابقة + أقنعة
    const rawTaskId = typeof rawArgs.image_task_id === "string" ? rawArgs.image_task_id : "";
    if (!rawTaskId) {
      return {
        input,
        error:
          "موديل grok-imagine-image-2-0/segment-edit هو موديل تعديل صور بالتجزئة وليس موديل فيديو — يحتاج image_task_id لمهمة صور Grok Imagine سابقة و mask_indexs لمؤشرات المناطق المطلوب تعديلها. لتوليد فيديو استخدم grok-imagine-video-1-5-preview.",
      };
    }
    // إن مرّر معرّف مهمة من قاعدتنا نحوله إلى معرّف المزود الفعلي
    input.task_id = resolvedTaskIdMap.get(rawTaskId) ?? rawTaskId;
    const masks = rawArgs.mask_indexs;
    if (Array.isArray(masks) && masks.length > 0) input.mask_indexs = masks.map((m) => Number(m)).filter((n) => Number.isFinite(n));
    return { input };
  }

  // grok-imagine-video-1-5-preview — التوثيق: prompt, image_urls, aspect_ratio,
  // resolution, duration (الصوت يُولَّد دائمًا مدمجًا مع الفيديو ولا يمكن إيقافه)
  if (model.type === "video") {
    if (args.image_url) input.image_urls = [args.image_url];
    if (args.aspect_ratio && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
    if (args.resolution) input.resolution = args.resolution;
    if (typeof args.duration === "number") input.duration = Math.max(1, Math.min(15, Math.round(args.duration)));
    return { input };
  }

  return { input };
}

/** إن أعطى العميل معرّف مهمة من قاعدتنا نحوّله لمعرّف المزود */
async function buildTaskIdMap(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const id of ids) {
    const t = await getTask(id);
    if (t?.provider_task_id) map.set(id, t.provider_task_id);
  }
  return map;
}

// ---------------------------------------------------------------------------
// صياغة الردود العربية (قسم 8 في المواصفة)

export function formatCompleted(task: TaskRow): string {
  const urls = resultUrls(task);
  if (task.type === "image") {
    const first = urls[0] ?? "";
    return `✅ تم توليد الصورة بنجاح\n\n![image](${first})\n\nالرابط المباشر: ${first}`;
  }
  if (task.type === "video") {
    const lines = urls.map((u) => `الرابط المباشر: ${u}`).join("\n");
    return `✅ تم توليد الفيديو بنجاح\n\n${lines}`;
  }
  const lines = urls.map((u) => `الرابط المباشر: ${u}`).join("\n");
  return `✅ تم دمج المقاطع بنجاح\n\n${lines}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
}

export function formatProcessing(task: TaskRow): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${task.id}\n\nالتقدم الحالي: ${task.progress}%\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

export function formatFailed(task: TaskRow): string {
  return `❌ فشلت المهمة: ${sanitizeErrorForClient(task.error_message) || "سبب غير معروف"}`;
}

// ---------------------------------------------------------------------------
// حلقة التجربة التسلسلية للمفاتيح + نافذة الانتظار

interface CandidateRun {
  ok: boolean;
  paramsError?: boolean;
  created?: {
    provider: ApiKeyRow["provider"];
    providerTaskId?: string;
    syncUrls?: string[];
    keyRow: ApiKeyRow;
  };
  lastError?: string;
}

function attemptRecord(keyRow: ApiKeyRow, ok: boolean, errorClass: string | null, error: string | null): AttemptRecord {
  return {
    provider: keyRow.provider,
    keyId: keyRow.id,
    keyLabel: keyRow.label || maskOf(keyRow),
    ok,
    errorClass: (errorClass as AttemptRecord["errorClass"]) ?? null,
    error: error ? error.slice(0, 300) : null,
    at: new Date().toISOString(),
  };
}

/** لا نطبع المفتاح أبدًا — نستخدم نسخة مقنّعة فقط في السجلات */
function maskOf(k: ApiKeyRow): string {
  if (k.api_key.length <= 14) return k.api_key.slice(0, 3) + "•••••";
  return k.api_key.slice(0, 7) + "••••••••" + k.api_key.slice(-4);
}

/**
 * تجربة المرشحين بالترتيب بدءًا من startIdx — أول نجاح يربط المهمة بالمزود
 * والمفتاح. كل محاولة تُسجَّل في attempts_json وعدّادات المفتاح تُحدَّث دائمًا.
 */
async function tryCandidates(
  task: TaskRow,
  model: ModelDef,
  input: Record<string, unknown>,
  candidates: ApiKeyRow[],
  startIdx: number,
): Promise<CandidateRun> {
  let lastError = "";
  for (let i = startIdx; i < candidates.length; i++) {
    const keyRow = candidates[i];
    const adapter = getAdapter(keyRow.provider);
    const providerModel = model.providerModel[keyRow.provider];
    try {
      // صور متزامنة إن دعمها المزود (CometAPI) — تعيد الروابط فورًا
      if (model.type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(keyRow.api_key, providerModel, input);
        await recordKeyUsage(keyRow.id, { ok: true });
        await updateTask(
          task.id,
          {
            provider: keyRow.provider,
            key_id: keyRow.id,
            status: "completed",
            progress: 100,
            result_urls_json: JSON.stringify(urls),
          },
          attemptRecord(keyRow, true, null, null),
        );
        return { ok: true, created: { provider: keyRow.provider, syncUrls: urls, keyRow } };
      }

      const { providerTaskId } = await adapter.createTask(keyRow.api_key, providerModel, input);
      await recordKeyUsage(keyRow.id, { ok: true });
      await updateTask(
        task.id,
        {
          provider: keyRow.provider,
          provider_task_id: providerTaskId,
          key_id: keyRow.id,
          status: "processing",
          progress: 5,
        },
        attemptRecord(keyRow, true, null, null),
      );
      return { ok: true, created: { provider: keyRow.provider, providerTaskId, keyRow } };
    } catch (e) {
      const status = (e as { status?: number }).status;
      const message = e instanceof Error ? e.message : String(e);
      const cls = classifyProviderError(status, message);
      await recordKeyUsage(keyRow.id, { ok: false, error: message, errorClass: cls });
      await updateTask(task.id, {}, attemptRecord(keyRow, false, cls, message));
      lastError = `[${cls}] ${message}`;
      if (cls === "params") {
        // توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
        return { ok: false, paramsError: true, lastError };
      }
      // disabled / exhausted / provider / temporary → انتقل للمفتاح التالي فورًا
      continue;
    }
  }
  return { ok: false, lastError };
}

/** خطوة استعلام واحدة عن مهمة جارية لدى المزود + تحديث القاعدة */
async function pollProviderTask(
  task: TaskRow,
  model: ModelDef,
  keyRow: ApiKeyRow | null,
): Promise<
  | { action: "completed"; urls: string[]; progress: number }
  | { action: "processing"; progress: number }
  | { action: "failed"; error: string; keyRelated: boolean }
  | { action: "recreate"; error: string }
> {
  if (!task.provider_task_id || !task.provider) {
    return { action: "recreate", error: "المهمة بلا معرّف مزود" };
  }
  // مهام التوليد مرتبطة بمزود generation فقط (kie/cometapi) — الدمج يُعالج في مسار مستقل
  const adapter = getAdapter(task.provider as ProviderId);
  const providerModel = model.providerModel[task.provider as ProviderId];
  if (!keyRow) {
    // حُذف المفتاح المستخدم؟ نجرّب إعادة الإنشاء على مفتاح آخر
    return { action: "recreate", error: "المفتاح المرتبط بالمهمة لم يعد موجودًا" };
  }
  const checkedKeyRow = keyRow;
  let check: ProviderCheckResult;
  try {
    check = await adapter.checkTask(checkedKeyRow.api_key, providerModel, task.provider_task_id);
  } catch (e) {
    const status = (e as { status?: number }).status;
    const message = e instanceof Error ? e.message : String(e);
    const cls = classifyProviderError(status, message);
    if (cls === "disabled" || cls === "exhausted") {
      await recordKeyUsage(checkedKeyRow.id, { ok: false, error: message, errorClass: cls });
      return { action: "recreate", error: message };
    }
    if (cls === "params" || cls === "provider") {
      return { action: "failed", error: message, keyRelated: false };
    }
    // temporary (429/5xx/شبكة) — نستمر بالاستعلام، المفتاح يبقى سليمًا
    return { action: "processing", progress: task.progress };
  }

  if (check.status === "completed") {
    const urls = check.urls ?? [];
    if (urls.length === 0) {
      return { action: "failed", error: "اكتمل التوليد لدى المزود دون روابط نتائج", keyRelated: false };
    }
    return { action: "completed", urls, progress: 100 };
  }
  if (check.status === "failed") {
    const msg = check.error || "فشل التوليد لدى المزود";
    if (isKeyOrBalanceRelated(msg)) {
      return { action: "recreate", error: msg };
    }
    return { action: "failed", error: msg, keyRelated: false };
  }
  // processing — تقدم متدرج: الأعلى بين تقدم المزود وزحف زمني بطيء حتى 92
  const elapsedBase = Math.min(92, (task.progress ?? 0) + 2);
  const progress = Math.max(check.progress ?? 0, elapsedBase, task.progress ?? 0);
  return { action: "processing", progress };
}

// ---------------------------------------------------------------------------
// runGeneration — لأداتي generate_image / generate_video

export async function runGeneration(opts: {
  model: string;
  args: {
    prompt: string;
    aspect_ratio?: string;
    resolution?: string;
    background?: string;
    output_format?: string;
    image_url?: string;
    duration?: number;
    image_task_id?: string;
    mask_indexs?: number[];
  };
  waitSeconds: number;
  onProgress?: ProgressCallback;
}): Promise<RunOutcome> {
  const model = findModel(opts.model);
  if (!model) {
    return { kind: "invalid", text: `❌ معطيات غير صالحة: موديل غير معروف «${opts.model}». الموديلات المتاحة: gpt-image-2-6/flare-text-to-image، grok-imagine-video-1-5-preview، grok-imagine-image-2-0/segment-edit.` };
  }
  if (model.type === "image" && (!opts.args.prompt || !opts.args.prompt.trim())) {
    return { kind: "invalid", text: "❌ معطيات غير صالحة: الوصف (prompt) مطلوب." };
  }

  // 2) مجمع المفاتيح بترتيب الإضافة — فارغ → رد no_keys
  const candidates = await getKeyPool(model.providers);
  if (candidates.length === 0) {
    return { kind: "invalid", text: `❌ لا توجد مفاتيح نشطة لخدمة ${model.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.` };
  }

  const taskId = randomUUID();
  const params = {
    args: opts.args,
    waitSeconds: opts.waitSeconds,
    nextAttemptAt: 0,
  };

  // 3) تسجيل المهمة في Turso قبل أي نداء خارجي
  await insertTask({
    id: taskId,
    model: model.canonical,
    type: model.type,
    prompt: opts.args.prompt.slice(0, 2000),
    paramsJson: JSON.stringify(params),
    status: "pending",
  });

  const { input, error: inputError } = buildProviderInput(
    model,
    opts.args,
    opts.args as unknown as Record<string, unknown>,
    await buildTaskIdMap(opts.args.image_task_id ? [opts.args.image_task_id] : []),
  );
  if (inputError) {
    // خطأ معطيات قبل النداء (مثل segment-edit بلا task_id)
    await updateTask(taskId, { status: "failed", error_message: inputError, progress: 0 });
    return { kind: "failed", taskId, text: `❌ فشلت المهمة: ${inputError}` };
  }

  // 4) تجربة المرشحين بالترتيب
  const run = await tryCandidates(
    { id: taskId } as TaskRow,
    model,
    input,
    candidates,
    0,
  );

  if (!run.ok) {
    if (run.paramsError) {
      const reason = sanitizeErrorForClient(run.lastError?.replace(/^\[params\]\s*/, ""));
      const msg = `معطيات الطلب غير مقبولة من المزود: ${reason}`;
      await updateTask(taskId, { status: "failed", error_message: msg });
      return { kind: "failed", taskId, text: `❌ فشلت المهمة: ${msg}` };
    }
    // فشل الإنشاء على كل المفاتيح ← تبقى processing وبانتظار مفتاح صالح (قاعدة 4.3.3)
    const nextAt = Date.now() + RECREATE_COOLDOWN_MS;
    await updateTask(taskId, {
      params_json: JSON.stringify({ ...params, nextAttemptAt: nextAt }),
      status: "processing",
      progress: 0,
      error_message: "بانتظار توفر مفتاح صالح…",
    });
    const fresh = (await getTask(taskId))!;
    return { kind: "processing", taskId, progress: 0, text: formatProcessing(fresh) };
  }

  // صورة متزامنة اكتملت فورًا
  if (run.created?.syncUrls) {
    const fresh = (await getTask(taskId))!;
    return { kind: "completed", taskId, urls: run.created.syncUrls, text: formatCompleted(fresh) };
  }

  // 5) نافذة الانتظار مع بث التقدم كل 3 ثوانٍ
  const windowResult = await waitWindow(taskId, model, opts.waitSeconds, opts.onProgress);
  if (windowResult.kind === "completed") {
    const fresh = (await getTask(taskId))!;
    return { kind: "completed", taskId, urls: windowResult.urls!, text: formatCompleted(fresh) };
  }
  if (windowResult.kind === "failed") {
    await updateTask(taskId, { status: "failed", error_message: windowResult.error });
    const fresh = (await getTask(taskId))!;
    return { kind: "failed", taskId, text: formatFailed(fresh) };
  }
  const fresh = (await getTask(taskId))!;
  return { kind: "processing", taskId, progress: fresh.progress, text: formatProcessing(fresh) };
}

// ---------------------------------------------------------------------------
// نافذة الانتظار المشتركة (تُستخدم أيضًا من refresh بعد إعادة الإنشاء)

async function waitWindow(
  taskId: string,
  model: ModelDef,
  waitSeconds: number,
  onProgress?: ProgressCallback,
): Promise<{ kind: "completed"; urls: string[] } | { kind: "failed"; error: string } | { kind: "timeout" } | { kind: "no_key" }> {
  const start = Date.now();
  const effective = Math.max(0, Math.min(waitSeconds, maxWaitSeconds()));
  const deadline = Math.min(start + effective * 1000, start + maxWaitSeconds() * 1000);

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (Date.now() >= deadline) break;

    const task = await getTask(taskId);
    if (!task) return { kind: "failed", error: "اخفت المهمة من قاعدة البيانات" };
    if (task.status === "completed") return { kind: "completed", urls: resultUrls(task) };
    if (task.status === "failed") return { kind: "failed", error: task.error_message ?? "" };

    const keyRow = task.key_id ? await getApiKey(task.key_id) : null;
    const step = await pollProviderTask(task, model, keyRow);

    if (step.action === "completed") {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify(step.urls) });
      await onProgress?.(100, "اكتمل التوليد");
      return { kind: "completed", urls: step.urls };
    }
    if (step.action === "failed") {
      return { kind: "failed", error: step.error };
    }
    if (step.action === "recreate") {
      // فشل في منتصف المهمة بسبب مفتاح/رصيد → إعادة إنشاء نفس المهمة بنفس
      // task_id على المفتاح التالي تلقائيًا دون توقف (قاعدة 4.3.2)
      const candidates = await getKeyPool(model.providers);
      const run = await tryCandidates(task, model, buildInputFromParams(model, task), candidates, 0);
      if (!run.ok) {
        if (run.paramsError) {
          return { kind: "failed", error: run.lastError?.replace(/^\[params\]\s*/, "") || "خطأ معطيات" };
        }
        await updateTask(taskId, {
          params_json: JSON.stringify({ ...parseParams(task), nextAttemptAt: Date.now() + RECREATE_COOLDOWN_MS }),
          error_message: "بانتظار توفر مفتاح صالح…",
        });
        return { kind: "timeout" };
      }
      if (run.created?.syncUrls) return { kind: "completed", urls: run.created.syncUrls };
      continue; // أُنشئت مهمة مزود جديدة بنفس task_id — واصل الاستعلام
    }

    await updateTask(taskId, { progress: step.progress });
    await onProgress?.(step.progress, `قيد التوليد… ${step.progress}%`);
  }
  return { kind: "timeout" };
}

/** بناء مدخلات المزود من المهمة المخزنة (لإعادة الإنشاء بعد انقطاع) */
function buildInputFromParams(model: ModelDef, task: TaskRow): Record<string, unknown> {
  const params = parseParams<{ args: Record<string, unknown> }>(task);
  const { input } = buildProviderInput(
    model,
    params.args as never,
    params.args,
    new Map(),
  );
  return input;
}

// ---------------------------------------------------------------------------
// refreshTask — لأداة get_task: تحديث حي من المزود + إعادة محاولة تلقائية

export async function refreshTask(taskId: string): Promise<RunOutcome> {
  const task = await getTask(taskId);
  if (!task) {
    return { kind: "invalid", text: `❌ لا توجد مهمة بالمعرّف ${taskId}.` };
  }
  if (task.status === "completed") return { kind: "completed", taskId, urls: resultUrls(task), text: formatCompleted(task) };
  if (task.status === "failed") return { kind: "failed", taskId, text: formatFailed(task) };

  if (task.type === "merge") return refreshMergeTask(task);

  const model = findModel(task.model);
  if (!model) {
    await updateTask(taskId, { status: "failed", error_message: "موديل غير معروف" });
    return { kind: "failed", taskId, text: formatFailed((await getTask(taskId))!) };
  }

  // مهمة بلا معرّف مزود: لم ينجح الإنشاء بعد — أعد المحاولة بعد فترة تهدئة 45 ثانية
  if (!task.provider_task_id) {
    const params = parseParams<{ nextAttemptAt?: number }>(task);
    if ((params.nextAttemptAt ?? 0) > Date.now()) {
      const fresh = (await getTask(taskId))!;
      return { kind: "processing", taskId, progress: fresh.progress, text: formatProcessing(fresh) + "\n\n(بانتظار توفر مفتاح صالح — تجري إعادة المحاولة تلقائيًا)" };
    }
    const candidates = await getKeyPool(model.providers);
    const run = await tryCandidates(task, model, buildInputFromParams(model, task), candidates, 0);
    if (!run.ok) {
      await updateTask(taskId, {
        params_json: JSON.stringify({ ...parseParams(task), nextAttemptAt: Date.now() + RECREATE_COOLDOWN_MS }),
        error_message: "بانتظار توفر مفتاح صالح…",
      });
      const fresh = (await getTask(taskId))!;
      return { kind: "processing", taskId, progress: fresh.progress, text: formatProcessing(fresh) };
    }
    if (run.created?.syncUrls) {
      const fresh = (await getTask(taskId))!;
      return { kind: "completed", taskId, urls: run.created.syncUrls, text: formatCompleted(fresh) };
    }
    return singleCheckAfterCreate(taskId, model);
  }

  // مهمة جارية لدى المزود — تحديث حي واحد
  const keyRow = task.key_id ? await getApiKey(task.key_id) : null;
  const step = await pollProviderTask(task, model, keyRow);
  if (step.action === "completed") {
    await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify(step.urls) });
    const fresh = (await getTask(taskId))!;
    return { kind: "completed", taskId, urls: step.urls, text: formatCompleted(fresh) };
  }
  if (step.action === "failed") {
    await updateTask(taskId, { status: "failed", error_message: step.error });
    const fresh = (await getTask(taskId))!;
    return { kind: "failed", taskId, text: formatFailed(fresh) };
  }
  if (step.action === "recreate") {
    const candidates = await getKeyPool(model.providers);
    const run = await tryCandidates(task, model, buildInputFromParams(model, task), candidates, 0);
    if (!run.ok) {
      await updateTask(taskId, {
        params_json: JSON.stringify({ ...parseParams(task), nextAttemptAt: Date.now() + RECREATE_COOLDOWN_MS }),
        error_message: "بانتظار توفر مفتاح صالح…",
      });
      const fresh = (await getTask(taskId))!;
      return { kind: "processing", taskId, progress: fresh.progress, text: formatProcessing(fresh) };
    }
    if (run.created?.syncUrls) {
      const fresh = (await getTask(taskId))!;
      return { kind: "completed", taskId, urls: run.created.syncUrls, text: formatCompleted(fresh) };
    }
    const fresh = (await getTask(taskId))!;
    return { kind: "processing", taskId, progress: fresh.progress, text: formatProcessing(fresh) };
  }
  await updateTask(taskId, { progress: step.progress });
  const fresh = (await getTask(taskId))!;
  return { kind: "processing", taskId, progress: fresh.progress, text: formatProcessing(fresh) };
}

/** فحص واحد سريع بعد إنشاء ناجح داخل get_task (بلا نافذة انتظار طويلة) */
async function singleCheckAfterCreate(taskId: string, model: ModelDef): Promise<RunOutcome> {
  const task = (await getTask(taskId))!;
  const keyRow = task.key_id ? await getApiKey(task.key_id) : null;
  const step = await pollProviderTask(task, model, keyRow);
  if (step.action === "completed") {
    await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify(step.urls) });
    const fresh = (await getTask(taskId))!;
    return { kind: "completed", taskId, urls: step.urls, text: formatCompleted(fresh) };
  }
  if (step.action === "failed") {
    await updateTask(taskId, { status: "failed", error_message: step.error });
    const fresh = (await getTask(taskId))!;
    return { kind: "failed", taskId, text: formatFailed(fresh) };
  }
  if (step.action === "recreate") {
    // فشل فوري بعد الإنشاء بسبب مفتاح/رصيد — نجدول إعادة المحاولة عند get_task التالي
    await updateTask(taskId, {
      params_json: JSON.stringify({ ...parseParams(task), nextAttemptAt: Date.now() + RECREATE_COOLDOWN_MS }),
      provider_task_id: null,
      key_id: null,
      error_message: "بانتظار توفر مفتاح صالح…",
    });
    const fresh = (await getTask(taskId))!;
    return { kind: "processing", taskId, progress: fresh.progress, text: formatProcessing(fresh) };
  }
  await updateTask(taskId, { progress: Math.max(step.progress, 5) });
  const fresh = (await getTask(taskId))!;
  return { kind: "processing", taskId, progress: fresh.progress, text: formatProcessing(fresh) };
}

// ---------------------------------------------------------------------------
// الدمج — runMerge و refreshMergeTask

function isPublicHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1|f[cd][0-9a-f]{2}:)/.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

export interface MergeValidation {
  ok: boolean;
  urls?: string[];
  text?: string;
}

/** التحقق الصارم قبل أي نداء: ≥2 و≤10 وكلها روابط عامة مباشرة، وحل task_ids بالترتيب */
export async function validateMergeInputs(
  urls: string[] | undefined,
  taskIds: string[] | undefined,
): Promise<MergeValidation> {
  const failedIds: string[] = [];
  const resolved: string[] = [];

  if (Array.isArray(taskIds) && taskIds.length > 0) {
    for (const id of taskIds) {
      const t = await getTask(id.trim());
      const u = t && t.status === "completed" && ["video", "merge"].includes(t.type) ? resultUrls(t)[0] : undefined;
      if (u) resolved.push(u);
      else failedIds.push(id);
    }
  }
  if (Array.isArray(urls)) {
    for (const u of urls) {
      if (typeof u === "string" && u.trim()) resolved.push(u.trim());
    }
  }

  if (resolved.length < 2) {
    let text = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (failedIds.length > 0) {
      text += `\n\nتفاصيل المعرّفات غير الصالحة: ${failedIds.join("، ")}`;
    }
    return { ok: false, text };
  }
  if (resolved.length > 10) {
    return { ok: false, text: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." };
  }
  const bad = resolved.find((u) => !isPublicHttpUrl(u));
  if (bad) {
    return { ok: false, text: `❌ كل المقاطع يجب أن تكون روابط فيديو مباشرة عامة (http/https). الرابط غير صالح: ${bad}` };
  }
  return { ok: true, urls: resolved };
}

export async function runMerge(opts: {
  urls?: string[];
  taskIds?: string[];
  waitSeconds: number;
  onProgress?: ProgressCallback;
}): Promise<RunOutcome> {
  if (!mergerConfigured()) {
    return { kind: "invalid", text: "❌ خدمة الدمج غير مهيأة بعد — اضبط متغير البيئة MERGER_API_BASE برابط موقع الدمج المنشور." };
  }
  const validation = await validateMergeInputs(opts.urls, opts.taskIds);
  if (!validation.ok) return { kind: "invalid", text: validation.text! };
  const videos = validation.urls!;

  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${videos.length} مقاطع`,
    paramsJson: JSON.stringify({ videos, waitSeconds: opts.waitSeconds, processStarted: false }),
    status: "pending",
  });

  // POST /api/jobs
  let jobId: string;
  try {
    const created = await mergerCreateJob(videos);
    jobId = created.jobId;
  } catch (e) {
    const msg = e instanceof MergerError && !e.declared ? "تعذر الاتصال بخدمة الدمج — سيُعاد المحاولة تلقائيًا مع get_task." : `فشل إنشاء مهمة الدمج: ${sanitizeErrorForClient(e instanceof Error ? e.message : String(e))}`;
    await updateTask(taskId, { status: "failed", error_message: msg });
    return { kind: "failed", taskId, text: `❌ فشلت المهمة: ${msg}` };
  }

  await updateTask(taskId, { provider: "merger", provider_task_id: jobId, status: "processing", progress: 5 });

  // إطلاق process خلفيًا وبمرة واحدة فقط (قفل في الذاكرة ضد التزامن مع get_task)
  void triggerProcessOnce(taskId, jobId);

  // نافذة انتظار قصيرة بالاستعلام كل 3 ثوانٍ مع بث التقدم
  const start = Date.now();
  const effective = Math.max(0, Math.min(opts.waitSeconds, maxWaitSeconds()));
  const deadline = Math.min(start + effective * 1000, start + maxWaitSeconds() * 1000);
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (Date.now() >= deadline) break;
    const st = await pollMergeStatus(taskId, jobId);
    if (st.kind === "done") {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify([st.url]) });
      await opts.onProgress?.(100, "اكتمل الدمج");
      const fresh = (await getTask(taskId))!;
      return { kind: "completed", taskId, urls: [st.url], text: formatCompleted(fresh) };
    }
    if (st.kind === "failed") {
      await updateTask(taskId, { status: "failed", error_message: st.error });
      const fresh = (await getTask(taskId))!;
      return { kind: "failed", taskId, text: formatFailed(fresh) };
    }
    await updateTask(taskId, { progress: st.progress });
    await opts.onProgress?.(st.progress, `قيد الدمج… ${st.progress}%`);
  }
  const fresh = (await getTask(taskId))!;
  return { kind: "processing", taskId, progress: fresh.progress, text: formatProcessing(fresh) };
}

/** قفل في الذاكرة يمنع تنفيذ process المتزامن لنفس المهمة */
const processInFlight = new Set<string>();

async function triggerProcessOnce(taskId: string, jobId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  const task = await getTask(taskId);
  if (!task) return;
  const params = parseParams<{ processStarted?: boolean }>(task);
  if (params.processStarted) return;
  processInFlight.add(jobId);
  try {
    await updateTask(taskId, { params_json: JSON.stringify({ ...parseParams(task), processStarted: true }) });
    await mergerProcessJob(jobId); // blocking ~10-15s — النتيجة تُلتقط من الاستعلام التالي
  } catch {
    // الخطأ المعلن يُكتشف ويُسجل عند أول استعلام حالة تالٍ
  } finally {
    processInFlight.delete(jobId);
  }
}

async function pollMergeStatus(
  taskId: string,
  jobId: string,
): Promise<{ kind: "done"; url: string } | { kind: "failed"; error: string } | { kind: "processing"; progress: number }> {
  try {
    const job = await mergerGetJob(jobId);
    if (job.status === "done") {
      const base = mergerBase()!;
      const url = mergerResultUrl(base, { ...job, jobId });
      return { kind: "done", url };
    }
    if (job.status === "failed") {
      return { kind: "failed", error: job.error || "فشل الدمج في خدمة الدمج" };
    }
    // قيد الانتظار/المعالجة → تأكد أن process أُطلق (مرة واحدة فقط)
    void triggerProcessOnce(taskId, jobId);
    return { kind: "processing", progress: Math.max(job.progress, 8) };
  } catch (e) {
    if (e instanceof MergerError && e.declared) {
      // أي خطأ HTTP معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
      return { kind: "failed", error: e.message };
    }
    // أخطاء شبكتنا نحن = مؤقتة → استمر بالاستعلام
    return { kind: "processing", progress: 40 };
  }
}

export async function refreshMergeTask(task: TaskRow): Promise<RunOutcome> {
  const taskId = task.id;
  if (!mergerConfigured()) {
    await updateTask(taskId, { status: "failed", error_message: "خدمة الدمج غير مهيأة (MERGER_API_BASE)" });
    return { kind: "failed", taskId, text: formatFailed((await getTask(taskId))!) };
  }

  // مهمة لم تُنشأ لدى الخدمة بعد (انقطاع بعد التسجيل) — أنشئها الآن بنفس task_id
  if (!task.provider_task_id) {
    const params = parseParams<{ videos?: string[] }>(task);
    if (!params.videos || params.videos.length < 2) {
      await updateTask(taskId, { status: "failed", error_message: "بيانات الدمج المخزنة غير مكتملة" });
      return { kind: "failed", taskId, text: formatFailed((await getTask(taskId))!) };
    }
    try {
      const created = await mergerCreateJob(params.videos);
      await updateTask(taskId, { provider: "merger", provider_task_id: created.jobId, status: "processing", progress: 5 });
      void triggerProcessOnce(taskId, created.jobId);
    } catch (e) {
      if (e instanceof MergerError && e.declared) {
        await updateTask(taskId, { status: "failed", error_message: `فشل إنشاء مهمة الدمج: ${e.message}` });
        return { kind: "failed", taskId, text: formatFailed((await getTask(taskId))!) };
      }
      const fresh = (await getTask(taskId))!;
      return { kind: "processing", taskId, progress: fresh.progress, text: formatProcessing(fresh) };
    }
  }

  const jobId = (await getTask(taskId))!.provider_task_id!;
  const st = await pollMergeStatus(taskId, jobId);
  if (st.kind === "done") {
    await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify([st.url]) });
    const fresh = (await getTask(taskId))!;
    return { kind: "completed", taskId, urls: [st.url], text: formatCompleted(fresh) };
  }
  if (st.kind === "failed") {
    await updateTask(taskId, { status: "failed", error_message: st.error });
    const fresh = (await getTask(taskId))!;
    return { kind: "failed", taskId, text: formatFailed(fresh) };
  }
  await updateTask(taskId, { progress: st.progress });
  const fresh = (await getTask(taskId))!;
  return { kind: "processing", taskId, progress: fresh.progress, text: formatProcessing(fresh) };
}

// ---------------------------------------------------------------------------
// list_media — استرجاع الوسائط المخزنة بروابطها (بدون إعادة توليد)

export async function listMedia(opts: { type?: MediaType; status?: TaskStatus; limit?: number }): Promise<string> {
  const tasks = await listRecentTasks(opts.limit ?? 10, { type: opts.type, status: opts.status });
  // بلا فلتر حالة نعرض المكتملة ذات الروابط؛ مع فلتر صريح نعرض طابقه
  const done = opts.status ? tasks : tasks.filter((t) => t.status === "completed");
  if (done.length === 0) {
    return "📂 لا توجد وسائط مخزنة مطابقة للفلترة المطلوبة بعد.";
  }
  const lines: string[] = [`📂 أحدث الوسائط المخزنة (${done.length}):`];
  done.forEach((t, i) => {
    const urls = resultUrls(t);
    const date = t.created_at ? t.created_at.replace("T", " ").slice(0, 16) : "";
    const statusAr = t.status === "completed" ? "مكتملة" : t.status === "failed" ? "فاشلة" : "جارية";
    lines.push(`\n${i + 1}. [${arTypeName(t.type)}] ${t.model} — ${statusAr} — ${date}`);
    lines.push(`   task_id: ${t.id}`);
    if (urls.length > 0) lines.push(urls.map((u) => `   الرابط: ${u}`).join("\n"));
  });
  return lines.join("\n");
}
