/**
 * نقطة الدخول API — POST /api/videocut (استُخرجت من المحرك لتظل تحت
 * vercel.json (functions على مسار api — حد 60 ثانية).
 *
 * الترجمة المتزامنة: مرّر captions_url (رابط http/https لملف SRT أو
 * data:text/…;base64) مع captions: true (الافتراضي) ليطبع FFmpeg الترجمة
 * على الفيديو النهائي بخط عربي/إنجليزي مضمّن في الخدمة.
 *
 * موسيقى الخلفية: مرّر bg_music_url (رابط http/https أو data:audio/… بصيغة base64)
 * ليكرر FFmpeg الملف/يقصه ليطابق مدة الفيديو ويخفض صوته (volume=0.12 ≈ -18dB)
 * مع تلاشٍ ختامي في آخر ثانيتين، ويدمجه مع صوت التعليق الأساسي عبر amix.
 */

const crypto = require("crypto");
const { insertJob } = require("./db");
const { runVideocutJob } = require("./videocut");

/** أقصى حجم مقبول لملف ترجمة (سطر أو data URL) */
const CAPTIONS_MAX_CHARS = 3_000_000;

async function handleVideocut(req, res) {
  if (req.method !== "POST") {
    return sendError(res, 405, "طريقة غير مسموحة — استخدم POST");
  }

  let body = null;
  try {
    body = await readJson(req);
  } catch {
    return sendError(res, 400, "جسم الطلب تالف — JSON صالح مطلوب");
  }

  const images = Array.isArray(body && body.images) ? body.images.map(String).filter((u) => /^(https?:\/\/|data:image\/)/i.test(u)) : [];
  if (images.length === 0) {
    return sendError(res, 400, 'مرّر مصفوفة روابط صور في {"images":["https://…","data:image/…"]}');
  }
  if (images.length > 20) {
    return sendError(res, 400, "أقصى عدد صور هو 20");
  }
  if (body.audio_url && !/^(https?:\/\/|data:audio\/)/i.test(String(body.audio_url))) {
    return sendError(res, 400, "رابط الصوت غير صالح — يجب أن يكون http/https أو data:audio/…");
  }

  // موسيقى الخلفية الاختيارية — نفس قيود رابط الصوت
  const bgMusicUrl = typeof body.bg_music_url === "string" ? body.bg_music_url.trim() : "";
  if (bgMusicUrl && !/^(https?:\/\/|data:audio\/)/i.test(bgMusicUrl)) {
    return sendError(res, 400, "رابط موسيقى الخلفية غير صالح — يجب أن يكون http/https أو data:audio/… بصيغة base64");
  }
  if (bgMusicUrl.length > CAPTIONS_MAX_CHARS) {
    return sendError(res, 413, "ملف موسيقى الخلفية كبير جدًا (الحد 3MB)");
  }

  // ملف الترجمة: http/https أو data:text/… أو data:application/… (base64)
  const captionsUrl = typeof body.captions_url === "string" ? body.captions_url.trim() : "";
  if (captionsUrl && !/^(https?:\/\/|data:text\/|data:application\/)/i.test(captionsUrl)) {
    return sendError(res, 400, "ملف الترجمة غير صالح — يجب أن يكون http/https أو data:text/… أو data:application/… بصيغة base64");
  }
  if (captionsUrl.length > CAPTIONS_MAX_CHARS) {
    return sendError(res, 413, "ملف الترجمة كبير جدًا (الحد 3MB)");
  }
  const captions = body.captions === false ? false : true;

  const jobId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  // sources_json كمصفوفة بعنصر واحد — يبقى GET /api/jobs/{id} متسقًا ولا يفشل
  await insertJob({
    id: jobId,
    status: "queued",
    sources_json: JSON.stringify([{ kind: "videocut", images, audio_url: body.audio_url || null, bg_music_url: bgMusicUrl || null, captions_url: captions ? captionsUrl || null : null, captions, aspect_ratio: body.aspect_ratio || "9:16", transition: body.transition || null, resolution: body.resolution || "720p", total_duration: body.total_duration || null }]),
    expires_at: expiresAt,
  });

  const result = await runVideocutJob(jobId, {
    images,
    audio_url: body.audio_url || null,
    bg_music_url: bgMusicUrl || null,
    captions_url: captions ? captionsUrl || null : null,
    captions,
    aspect_ratio: body.aspect_ratio || "9:16",
    transition: body.transition,
    resolution: body.resolution,
    total_duration: body.total_duration,
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
      if (data.length > 2e6) reject(new Error("too large"));
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

module.exports = { handleVideocut };
