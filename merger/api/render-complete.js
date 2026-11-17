/**
 * POST /api/render-complete — استلام ناتج الرندر الكامل من عامل GitHub Actions
 * وتحديث حالة المهمة في جدول tasks (Turso) — نفس قاعدة بيانات Meko.
 *
 * لماذا هذه النقطة؟ العامل لا يحمل بيانات قاعدة البيانات؛ meko-manger هو طبقة
 * القاعدة والخدمة في هذا النظام — العامل يرفع الفيديو هنا ويحدث المهمة عبرنا
 * (وتوجد لديه مسار احتياطي مباشر لـ Turso إن فشل الوصول إلينا بالكامل).
 *
 * الأمان بمعرفة القدرة (capability): التحديث مسموح فقط للمهمة التي
 *  - model = code-video-pipeline، و
 *  - job_id الممرر يطابق params.videoJobId أو params.ghJobId المُسجلان
 *    عند إطلاق الـ workflow من Meko نفسه — معرفان UUID غير قابلين للتخمين.
 *
 * العمليات (query op):
 *  op=chunk    ?task_id&job_id&chunk=N  — جسم ثنائي ≤2.5MB (أجزاء الفيديو في output_chunks)
 *  op=finalize ?task_id&job_id          — جسم JSON {width,height,fps,duration,frames,size,video_url_override?}
 *                                         يتحقق من الأجزاء، ينشئ صف jobs (يُخدم عبر /api/jobs/{id}/video)
 *                                         ويحدّث tasks: status=completed, progress=100, video_url=…
 *  op=progress ?task_id&job_id&p=NN     — تقدم حي (10..95) أثناء الرندر
 *  op=failed   ?task_id&job_id          — جسم JSON {error} — يفشل المهمة وينظف الأجزاء
 */

const { getDb, ensureSchema, LIMITS } = require("../lib/db");

const CHUNK_MAX_BYTES = 2.5 * 1024 * 1024;
const MAX_CHUNKS = 80; // 80 × 2.5MB = 200MB سقف نظري — حد الناتج الفعلي يُفحص في finalize
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_VIDEO_MODEL = "code-video-pipeline";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return send(res, 405, { error: "طريقة غير مسموحة — استخدم POST" });
  }

  const op = String(req.query.op || "chunk");

  // op=provision — إنشاء مهمة جديدة من عامل/مُشغل يدوي (task_id="new"):
  // توليد المعرفين وتسجيل المهمة في Turso بمعرّف الإطلاق نفسه، فتُكتمل لاحقًا
  // بنفس آلية القدرة (job_id المُسجل هو مفتاح التحديث)
  if (op === "provision") return await handleProvision(req, res);

  const taskId = String(req.query.task_id || "");
  const jobId = String(req.query.job_id || "");
  if (!UUID_RE.test(taskId) || !UUID_RE.test(jobId)) {
    return send(res, 400, { error: "task_id و job_id مطلوبان بصيغة UUID (أو استخدم op=provision لإنشاء مهمة جديدة)" });
  }

  try {
    await ensureSchema();
    const db = getDb();
    const task = await loadTask(db, taskId);
    if (!task) {
      return send(res, 404, { error: "المهمة غير موجودة في جدول tasks" });
    }
    if (task.model !== CODE_VIDEO_MODEL) {
      return send(res, 403, { error: `المهمة ليست من خط الفيديو البرمجي (${task.model})` });
    }
    const expected = videoJobIds(task);
    if (!expected.includes(jobId)) {
      return send(res, 403, { error: "job_id لا يطابق المُسجل على المهمة عند الإطلاق — رفض التحديث" });
    }

    if (op === "chunk") return await handleChunk(db, req, res, jobId);
    if (op === "finalize") return await handleFinalize(db, req, res, taskId, jobId, task);
    if (op === "progress") return await handleProgress(db, req, res, taskId);
    if (op === "failed") return await handleFailed(db, req, res, taskId, jobId);
    return send(res, 400, { error: "op غير معروف — استخدم provision أو chunk أو finalize أو progress أو failed" });
  } catch (e) {
    return send(res, 500, { error: e instanceof Error ? e.message.slice(0, 400) : String(e) });
  }
};

// ---------------------------------------------------------------------------
// op=provision — إنشاء مهمة رندر كامل جديدة (للمشغّل اليدوي أو اختبار E2E)

async function handleProvision(req, res) {
  let body = {};
  try {
    body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString("utf8") || "{}") || {};
  } catch {
    return send(res, 400, { error: "جسم provision يجب أن يكون JSON صالحًا" });
  }
  const htmlCode = typeof body.html_code === "string" ? body.html_code : "";
  if (htmlCode.trim().length < 100 || !/renderAtTime/.test(htmlCode)) {
    return send(res, 400, { error: "html_code غير صالح — صفحة HTML ذاتية الاحتواء تعرّف window.renderAtTime مطلوبة (100 حرفًا على الأقل)" });
  }
  const crypto = require("crypto");
  const taskId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const width = Math.round(Number(body.width) || 1080);
  const height = Math.round(Number(body.height) || 1920);
  const fps = Math.round(Number(body.fps) || 30);
  const duration = Number(body.duration_seconds) || 15;
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : "فيديو برمجي — رندر كامل";
  const params = {
    title,
    htmlCode,
    voice: "",
    aspectRatio: height >= width ? "9:16" : width >= height * 1.2 ? "16:9" : "1:1",
    width,
    height,
    fps,
    durationSeconds: duration,
    stage: "render",
    renderDispatched: true,
    dispatchedAt: new Date().toISOString(),
    ghJobId: jobId,
    renderHost: "github-actions",
    source: "provision",
    failCount: 0,
  };
  if (typeof body.audio_url === "string" && body.audio_url) params.audioUrl = body.audio_url;
  if (Array.isArray(body.word_timings) && body.word_timings.length >= 2) params.wordTimings = body.word_timings;
  // الترجمة الحركية وموسيقى الخلفية — تمرر للعامل عبر الحمولة/المدخلات
  if (body.captions === false) params.captions = false;
  if (body.caption_style === "single-pop") params.captionStyle = "single-pop";
  if (typeof body.bg_music_url === "string" && body.bg_music_url && /^(https?:\/\/|ambient|auto|true|1)/i.test(body.bg_music_url)) {
    params.bgMusicUrl = body.bg_music_url.slice(0, 600);
  }

  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, model, type, prompt, params_json, status, progress) VALUES (?,?,?,?,?,?,?)`,
    args: [taskId, CODE_VIDEO_MODEL, "video", `فيديو برمجي (رندر كامل): ${title}`.slice(0, 2000), JSON.stringify(params), "processing", 12],
  });
  return send(res, 200, { ok: true, task_id: taskId, job_id: jobId, title, width, height, fps, duration_seconds: duration });
}

// ---------------------------------------------------------------------------
// قراءة المهمة واستخراج معرفات الإطلاق

async function loadTask(db, taskId) {
  const r = await db.execute({
    sql: `SELECT id, model, status, params_json FROM tasks WHERE id = ?`,
    args: [taskId],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  let params = {};
  try {
    params = JSON.parse(String(row.params_json || "{}")) || {};
  } catch {
    params = {};
  }
  return {
    id: String(row.id),
    model: String(row.model),
    status: String(row.status),
    params,
  };
}

function videoJobIds(task) {
  const ids = [];
  if (typeof task.params.ghJobId === "string" && task.params.ghJobId) ids.push(task.params.ghJobId);
  if (typeof task.params.videoJobId === "string" && task.params.videoJobId && !ids.includes(task.params.videoJobId)) {
    ids.push(task.params.videoJobId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// op=chunk — أجزاء الفيديو الثنائية إلى output_chunks

async function handleChunk(db, req, res, jobId) {
  const chunk = Number(req.query.chunk);
  if (!Number.isInteger(chunk) || chunk < 0 || chunk >= MAX_CHUNKS) {
    return send(res, 400, { error: `chunk يجب أن يكون بين 0 و${MAX_CHUNKS - 1}` });
  }
  const buf = await readBody(req, CHUNK_MAX_BYTES);
  if (!buf || buf.length === 0) {
    return send(res, 400, { error: "جسم الطلب فارغ — أرسل الأجزاء الثنائية كما هي (application/octet-stream)" });
  }
  // الجزء 0 يمسح أي أجزاء قديمة لنفس المعرّف (إعادة رندر بنفس job_id قد تترك
  // ذيلاً قديمًا أطول من الناتج الجديد فيفسد الملف المُخدَم) — الرفع تسلسلي
  // من العامل فالجزء 0 يصل أولًا دائمًا
  if (chunk === 0) {
    await db.execute({ sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [jobId] });
  }
  await db.execute({
    sql: `INSERT OR REPLACE INTO output_chunks (job_id, chunk_seq, data) VALUES (?,?,?)`,
    args: [jobId, chunk, buf],
  });
  const total = await db.execute({
    sql: `SELECT COALESCE(SUM(length(data)),0) AS t, COUNT(*) AS n FROM output_chunks WHERE job_id = ?`,
    args: [jobId],
  });
  return send(res, 200, {
    ok: true,
    received: buf.length,
    totalBytes: Number(total.rows[0]?.t || 0),
    totalChunks: Number(total.rows[0]?.n || 0),
  });
}

// ---------------------------------------------------------------------------
// op=finalize — التحقق وإنشاء صف jobs وتحديث المهمة إلى completed/100

async function handleFinalize(db, req, res, taskId, jobId, task) {
  let body = {};
  try {
    body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}") || {};
  } catch {
    return send(res, 400, { error: "جسم finalize يجب أن يكون JSON صالحًا" });
  }

  const width = Math.round(Number(body.width) || 0);
  const height = Math.round(Number(body.height) || 0);
  const fps = Number(body.fps) || 0;
  const duration = Number(body.duration) || 0;
  const frames = Math.round(Number(body.frames) || 0);
  const declaredSize = Math.round(Number(body.size) || 0);
  if (width < 240 || height < 240 || fps <= 0 || duration <= 0 || frames <= 0) {
    return send(res, 400, { error: "width/height/fps/duration/frames مطلوبة بأرقام سليمة" });
  }

  // مسار الاحتياط: رابط خارجي (إصدار GitHub) إن تعذر تخزين الأجزاء عندنا
  const overrideUrl = typeof body.video_url_override === "string" && /^https:\/\//i.test(body.video_url_override) ? body.video_url_override : null;

  const base = publicBase(req);
  let videoUrl;
  let size = declaredSize;

  if (overrideUrl) {
    // ناتج مرفوع خارجيًا — نظف أي أجزاء جزئية ولا ننشئ صف jobs
    await db.execute({ sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [jobId] });
    videoUrl = overrideUrl;
  } else {
    const totalRow = await db.execute({
      sql: `SELECT COALESCE(SUM(length(data)),0) AS t, COUNT(*) AS n FROM output_chunks WHERE job_id = ?`,
      args: [jobId],
    });
    const totalBytes = Number(totalRow.rows[0]?.t || 0);
    const totalChunks = Number(totalRow.rows[0]?.n || 0);
    if (totalChunks === 0) {
      return send(res, 409, { error: "لا توجد أجزاء مرفوعة لهذا المعرّف — ارفعها بـ op=chunk أولًا" });
    }
    if (declaredSize > 0 && Math.abs(totalBytes - declaredSize) > 1024) {
      return send(res, 409, { error: `الأجزاء غير مكتملة (${totalBytes} بايت مقابل المعلن ${declaredSize}) — أعد الأجزاء الناقصة ثم أعد finalize` });
    }
    if (totalBytes > LIMITS.OUTPUT_MAX_MB() * 1048576) {
      await db.execute({ sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [jobId] });
      return send(res, 413, { error: `حجم الناتج (${(totalBytes / 1048576).toFixed(1)}MB) يتجاوز الحد ${LIMITS.OUTPUT_MAX_MB()}MB` });
    }
    size = totalBytes;
    videoUrl = `${base}/api/jobs/${jobId}/video`;
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
    await db.execute({
      sql: `INSERT OR REPLACE INTO jobs
              (id, status, progress, sources_json, video_url, download_url, size, duration, resolution, expires_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [
        jobId,
        "done",
        100,
        JSON.stringify([{
          kind: "codevideo-gh",
          source: "github-actions",
          task_id: taskId,
          width,
          height,
          fps,
          duration,
          frames,
          size,
        }]),
        videoUrl,
        `${videoUrl}?download=1`,
        size,
        duration,
        `${width}x${height}`,
        expiresAt,
      ],
    });
  }

  const downloadUrl = overrideUrl ? videoUrl : `${videoUrl}?download=1`;

  // دمج حقول النتيجة في params_json الحالية (نقرأ نسخة طازجة لتقليل سباق التحديث)
  const fresh = await loadTask(db, taskId);
  const params = fresh ? fresh.params : task.params;
  params.videoUrl = videoUrl;
  params.videoDownloadUrl = downloadUrl;
  params.videoDuration = duration;
  params.videoFps = fps;
  params.videoFrames = frames;
  params.videoJobId = jobId;
  if (!params.ghJobId) params.ghJobId = jobId;
  params.renderHost = "github-actions";
  params.renderDispatched = true;
  params.dispatchedAt = params.dispatchedAt || new Date().toISOString();
  params.width = width;
  params.height = height;
  params.fps = fps;
  params.stage = "render";

  await db.execute({
    sql: `UPDATE tasks SET
            status = 'completed',
            progress = 100,
            result_urls_json = ?,
            params_json = ?,
            error_message = NULL,
            completed_at = datetime('now'),
            updated_at = datetime('now')
          WHERE id = ?`,
    args: [JSON.stringify([videoUrl]), JSON.stringify(params), taskId],
  });

  // إشعار الأتمتة: ويب هوك POST إلى webhook_callback_url إن كان مسجلًا على
  // المهمة (بوابة n8n — task_id + status + video_url + title) — قد يعيد
  // الدمج استجابته بعد الإرسال، فلا يُمنع الناتج على فشل الويب هوك
  const webhook = await fireAutomationWebhook(params, {
    task_id: taskId,
    status: "completed",
    video_url: videoUrl,
    title: params.title ?? "",
  });

  return send(res, 200, {
    ok: true,
    task_id: taskId,
    job_id: jobId,
    status: "completed",
    video_url: videoUrl,
    download_url: downloadUrl,
    size,
    duration,
    resolution: `${width}x${height}`,
    fps,
    frames,
    host: overrideUrl ? "external" : "meko-manger",
    ...(webhook ? { webhook } : {}),
  });
}

// ---------------------------------------------------------------------------
// op=progress — تقدم حي (10..95) أثناء عمل العامل

async function handleProgress(db, req, res, taskId) {
  const p = Math.round(Number(req.query.p));
  if (!Number.isFinite(p) || p < 10 || p > 95) {
    return send(res, 400, { error: "p يجب أن يكون بين 10 و95" });
  }
  await db.execute({
    sql: `UPDATE tasks SET progress = ?, updated_at = datetime('now') WHERE id = ? AND status = 'processing'`,
    args: [p, taskId],
  });
  return send(res, 200, { ok: true, progress: p });
}

// ---------------------------------------------------------------------------
// op=failed — فشل صريح من العامل مع تنظيف الأجزاء

async function handleFailed(db, req, res, taskId, jobId) {
  let body = {};
  try {
    body = JSON.parse((await readBody(req, 16 * 1024)).toString("utf8") || "{}") || {};
  } catch {
    /* جسم اختياري */
  }
  const error = typeof body.error === "string" && body.error.trim() ? body.error.trim().slice(0, 490) : "فشل الرندر على GitHub Actions بلا رسالة.";
  // نقرأ المهمة أولًا لجلب ويب هوك الأتمتة إن كان مسجلًا في params
  const task = await loadTask(db, taskId);
  await db.execute({
    sql: `UPDATE tasks SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ? AND status != 'completed'`,
    args: [error, taskId],
  });
  await db.execute({ sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [jobId] });
  // إشعار فشل الأتمتة — كي يتعامل معه n8n (إعادة محاولة أو تنبيه)
  let webhook = null;
  if (task && typeof task.params.webhookCallbackUrl === "string" && /^https?:\/\//i.test(task.params.webhookCallbackUrl)) {
    webhook = await fireAutomationWebhook(task.params, {
      task_id: taskId,
      status: "failed",
      video_url: null,
      title: task.params.title ?? "",
      error: error.slice(0, 300),
    });
  }
  return send(res, 200, { ok: true, status: "failed", ...(webhook ? { webhook } : {}) });
}

// ---------------------------------------------------------------------------
// أدوات

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`الجزء أكبر من الحد ${(maxBytes / 1048576).toFixed(2)}MB`));
        return;
      }
      chunks.push(Buffer.from(c));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function publicBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:8787";
  const proto = req.headers["x-forwarded-proto"] || (String(host).startsWith("localhost") || String(host).startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * إشعار الأتمتة — POST JSON إلى webhook_callback_url المسجل في params المهمة
 * (بوابة n8n). مهلة 10 ثوانٍ، والنتيجة تُعاد في استجابة الدمج (sent/failed)
 * دون أن تُفشل عملية النشر نفسها.
 */
async function fireAutomationWebhook(params, payload) {
  const url = typeof params.webhookCallbackUrl === "string" && /^https?:\/\//i.test(params.webhookCallbackUrl) ? params.webhookCallbackUrl.trim() : null;
  if (!url || url.length > 600) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "meko-manger-webhook/1" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`[render-complete] automation webhook ${res.status} → ${url.slice(0, 120)}`);
    return res.ok ? "sent" : `failed-http-${res.status}`;
  } catch (e) {
    console.error(`[render-complete] automation webhook فشل: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    return "failed";
  }
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
