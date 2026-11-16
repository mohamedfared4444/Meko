/**
 * نقطة الدخول API — POST /api/codevideo (استُخرجت من المحرك لتظل تحت
 * vercel.json — functions على مسار api بحد 60 ثانية).
 *
 * فيديو الأنيميشن البرمجي: صفحة HTML/CSS/SVG/JS ذاتية الاحتواء تحدد
 * window.renderAtTime(t, duration, wordTimings) → إطارات عبر Chromium
 * → MP4 عبر ffmpeg. الصوت اختياري (audio_url) ويحدد مدة الفيديو عند وجوده،
 * وتوقيتات الكلمات (word_timings) تُمرر للدالة في كل إطار لمزامنة النطق.
 */

const crypto = require("crypto");
const { insertJob } = require("./db");
const { runCodeVideoJob } = require("../lib/codevideo");

/** حد طول كود HTML الواحد */
const HTML_MAX_CHARS = 300_000;
/** حد حجم جسم الطلب — كود المشهد + توقيتات الكلمات (Vercel يقبل ~4.5MB) */
const BODY_MAX_CHARS = 4_000_000;

async function handleCodeVideo(req, res) {
  if (req.method !== "POST") {
    return sendError(res, 405, "طريقة غير مسموحة — استخدم POST");
  }

  let body = null;
  try {
    body = await readJson(req);
  } catch {
    return sendError(res, 400, "جسم الطلب تالف أو كبير جدًا — JSON صالح مطلوب");
  }

  const htmlCode = typeof body?.html_code === "string" ? body.html_code : "";
  if (htmlCode.trim().length < 100) {
    return sendError(res, 400, 'مرّر كود المشهد المتحرك في {"html_code":"…"} — صفحة HTML/CSS/SVG/JS ذاتية الاحتواء (100 حرفًا على الأقل)');
  }
  if (htmlCode.length > HTML_MAX_CHARS) {
    return sendError(res, 413, `html_code طويل جدًا (${htmlCode.length} حرفًا) — الحد ${HTML_MAX_CHARS} حرفًا`);
  }
  if (!/renderAtTime/.test(htmlCode)) {
    return sendError(res, 400, 'html_code لا يحتوي renderAtTime إطلاقًا — عرّف window.renderAtTime(t, duration, wordTimings) داخل <script> لرسم حالة المشهد في أي لحظة t');
  }
  if (body.audio_url && !/^(https?:\/\/|data:audio\/)/i.test(String(body.audio_url))) {
    return sendError(res, 400, "رابط الصوت غير صالح — يجب أن يكون http/https أو data:audio/…");
  }
  if (body.duration_seconds !== undefined && (!Number.isFinite(Number(body.duration_seconds)) || Number(body.duration_seconds) < 1 || Number(body.duration_seconds) > 60)) {
    return sendError(res, 400, "duration_seconds يجب أن يكون بين 1 و60 ثانية");
  }
  if (body.fps !== undefined && (!Number.isFinite(Number(body.fps)) || Number(body.fps) < 8 || Number(body.fps) > 30)) {
    return sendError(res, 400, "fps يجب أن يكون بين 8 و30");
  }
  for (const dim of ["width", "height"]) {
    if (body[dim] !== undefined && (!Number.isInteger(Number(body[dim])) || Number(body[dim]) < 240 || Number(body[dim]) > 1280 || Number(body[dim]) % 2 !== 0)) {
      return sendError(res, 400, `${dim} يجب أن يكون عددًا زوجيًا بين 240 و1280`);
    }
  }
  if (body.word_timings !== undefined && !Array.isArray(body.word_timings)) {
    return sendError(res, 400, 'word_timings يجب أن تكون مصفوفة من {start,end,text} بالثواني');
  }

  const jobId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  // sources_json كمصفوفة بعنصر واحد — يبقى GET /api/jobs/{id} متسقًا ولا يفشل
  await insertJob({
    id: jobId,
    status: "queued",
    sources_json: JSON.stringify([{
      kind: "codevideo",
      html_chars: htmlCode.length,
      audio_url: body.audio_url || null,
      duration_seconds: body.duration_seconds || null,
      fps: body.fps || null,
      width: body.width || null,
      height: body.height || null,
      word_timings_count: Array.isArray(body.word_timings) ? body.word_timings.length : 0,
    }]),
    expires_at: expiresAt,
  });

  const result = await runCodeVideoJob(jobId, {
    html_code: htmlCode,
    audio_url: body.audio_url || null,
    duration_seconds: body.duration_seconds || null,
    fps: body.fps || null,
    width: body.width || null,
    height: body.height || null,
    word_timings: Array.isArray(body.word_timings) ? body.word_timings : null,
    _publicBase: publicBase(req),
  });

  res.writeHead(result.httpStatus || 500, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(result));
}

function publicBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:8787";
  const proto = req.headers["x-forwarded-proto"] || (String(host).startsWith("localhost") || String(host).startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > BODY_MAX_CHARS) reject(new Error("too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "null"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendError(res, status, message) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
}

module.exports = { handleCodeVideo };
