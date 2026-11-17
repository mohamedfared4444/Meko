/**
 * POST /api/render-payload — تخزين حمولة الرندر الكامل (كود المشهد + الصوت +
 * توقيتات الكلمات) التي يرفعها Meko قبل إطلاق workflow على GitHub Actions.
 *
 * لماذا؟ مدخلات workflow_dispatch في GitHub محدودة بـ ~64KB إجمالًا، وكود
 * المشهد يصل 150-300KB — فتُخزَّن الحمولة هنا ويُمرر للـ workflow رابط تحميل
 * (payload_url) يجلبها العامل قبل الرندر.
 *
 * POST — الجسم JSON:
 *   { "task_id": uuid, "job_id": uuid, "title": "…",
 *     "html_code": "<!doctype html>…", "audio_url": "https://…" | null,
 *     "word_timings": [{start,end,text}] | null, "duration_seconds": 20 | null }
 *   → { ok, payload_id, payload_url, expires_at }
 *
 * GET /api/render-payload?id=<uuid> — يقرأها عامل GitHub Actions (بلا أي توثيق:
 * المعرّف UUID غير قابل للتخمين) — يعيد كائن الحمولة كما حُفظت.
 * الصلاحية 24 ساعة — بعدها 404 وتُحذف الصف (التنظيف اليومي في /api/cron).
 */

const crypto = require("crypto");
const { getDb, ensureSchema } = require("../lib/db");

/** حد حجم الحمولة الواحدة — كود المشهد حتى 300KB + صوت مضمّن data: حتى ~1.8MB
 *  (Edge-TTS لمشهد طويل) + توقيتات الكلمات وهامش JSON (حد جسم Vercel 4.5MB) */
const PAYLOAD_MAX_BYTES = 4 * 1024 * 1024;
/** حد طول كود HTML المتاح للرندر (نفس حد نقطة codevideo) */
const HTML_MAX_CHARS = 300_000;
const RETENTION_HOURS = 24;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  if (req.method === "GET") return handleGet(req, res);
  if (req.method === "POST") return handlePost(req, res);
  return send(res, 405, { error: "طريقة غير مسموحة — استخدم POST للتخزين أو GET للقراءة" });
};

async function handlePost(req, res) {
  let body = null;
  try {
    body = await readJson(req, PAYLOAD_MAX_BYTES);
  } catch (e) {
    return send(res, 400, { error: `جسم الطلب تالف أو أكبر من الحد: ${e instanceof Error ? e.message : "JSON صالح مطلوب"}` });
  }

  const taskId = String(body?.task_id || "");
  const jobId = String(body?.job_id || "");
  const htmlCode = typeof body?.html_code === "string" ? body.html_code : "";
  if (!UUID_RE.test(taskId) || !UUID_RE.test(jobId)) {
    return send(res, 400, { error: "task_id و job_id يجب أن يكونا UUID صالحين" });
  }
  if (htmlCode.trim().length < 100) {
    return send(res, 400, { error: "html_code قصير جدًا — صفحة HTML ذاتية الاحتواء (100 حرفًا على الأقل) مطلوبة" });
  }
  if (htmlCode.length > HTML_MAX_CHARS) {
    return send(res, 413, { error: `html_code طويل جدًا (${htmlCode.length} حرفًا) — الحد ${HTML_MAX_CHARS}` });
  }
  if (!/renderAtTime/.test(htmlCode)) {
    return send(res, 400, { error: "html_code لا يحتوي renderAtTime — عرّف window.renderAtTime(t, duration, wordTimings)" });
  }
  if (body?.audio_url && !/^(https?:\/\/|data:audio\/)/i.test(String(body.audio_url))) {
    return send(res, 400, { error: "audio_url يجب أن يكون http/https أو data:audio/…" });
  }
  if (body?.word_timings != null && !Array.isArray(body.word_timings)) {
    return send(res, 400, { error: "word_timings يجب أن تكون مصفوفة من {start,end,text}" });
  }
  // موسيقى الخلفية: رابط http(s) أو "ambient" (توليد نغمة خفيفة على العامل)
  const bgMusic = body?.bg_music_url != null && String(body.bg_music_url).trim() !== "" ? String(body.bg_music_url).trim() : null;
  if (bgMusic && !/^(https?:\/\/|ambient|auto|true|1)/i.test(bgMusic)) {
    return send(res, 400, { error: "bg_music_url يجب أن يكون رابط http/https أو الكلمة ambient" });
  }

  // الحمولة تُخزَّن كما هي — العامل يقرأها بحقولها نفسها
  const payload = {
    task_id: taskId,
    job_id: jobId,
    title: typeof body.title === "string" ? body.title.slice(0, 200) : "",
    html_code: htmlCode,
    audio_url: body.audio_url || null,
    word_timings: Array.isArray(body.word_timings) ? body.word_timings : null,
    duration_seconds: Number.isFinite(Number(body.duration_seconds)) ? Number(body.duration_seconds) : null,
    // الترجمة الحركية: العامل يفعّلها افتراضيًا — false هنا يوقفها صراحة
    captions: typeof body.captions === "boolean" ? body.captions : null,
    // موسيقى الخلفية: رابط http(s) أو ambient (≤600 حرفًا)
    bg_music_url: bgMusic ? bgMusic.slice(0, 600) : null,
    source: "meko",
  };

  const payloadId = crypto.randomUUID();
  const db = getDb();
  await ensureSchema();
  await db.execute({
    sql: `INSERT OR REPLACE INTO render_payloads (id, payload) VALUES (?,?)`,
    args: [payloadId, JSON.stringify(payload)],
  });

  const base = publicBase(req);
  return send(res, 200, {
    ok: true,
    payload_id: payloadId,
    payload_url: `${base}/api/render-payload?id=${payloadId}`,
    expires_at: new Date(Date.now() + RETENTION_HOURS * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19),
  });
}

async function handleGet(req, res) {
  const id = String(req.query.id || "").trim();
  if (!UUID_RE.test(id)) {
    return send(res, 400, { error: "معرّف الحمولة (id) مطلوب بصيغة UUID" });
  }
  await ensureSchema();
  const db = getDb();
  const r = await db.execute({ sql: `SELECT payload, created_at FROM render_payloads WHERE id = ?`, args: [id] });
  if (r.rows.length === 0) {
    return send(res, 404, { error: "الحمولة غير موجودة — انتهت صلاحيتها (24 ساعة) أو لم تُخزَّن بعد" });
  }
  const createdAt = String(r.rows[0].created_at || "");
  const ageMs = Date.now() - Date.parse(createdAt.includes("T") ? createdAt : createdAt.replace(" ", "T") + "Z");
  if (Number.isFinite(ageMs) && ageMs > RETENTION_HOURS * 3600 * 1000) {
    await db.execute({ sql: `DELETE FROM render_payloads WHERE id = ?`, args: [id] });
    return send(res, 404, { error: "الحمولة انتهت صلاحيتها (24 ساعة)" });
  }
  try {
    const payload = JSON.parse(String(r.rows[0].payload));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(payload));
  } catch {
    await db.execute({ sql: `DELETE FROM render_payloads WHERE id = ?`, args: [id] });
    return send(res, 500, { error: "الحمولة المخزنة تالفة — أعد تخزينها من Meko" });
  }
}

function publicBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:8787";
  const proto = req.headers["x-forwarded-proto"] || (String(host).startsWith("localhost") || String(host).startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`تجاوز الحد ${(maxBytes / 1048576).toFixed(1)}MB`));
        return;
      }
      chunks.push(Buffer.from(c));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch (e) {
        reject(new Error("JSON غير صالح"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
