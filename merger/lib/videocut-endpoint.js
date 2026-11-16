/**
 * نقطة الدخول API — POST /api/videocut (استُخرجت من المحرك لتظل تحت
 * vercel.json (functions على مسار api — حد 60 ثانية).
 */

const crypto = require("crypto");
const { insertJob } = require("./db");
const { runVideocutJob } = require("./videocut");

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

  const jobId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  // sources_json كمصفوفة بعنصر واحد — يبقى GET /api/jobs/{id} متسقًا ولا يفشل
  await insertJob({
    id: jobId,
    status: "queued",
    sources_json: JSON.stringify([{ kind: "videocut", images, audio_url: body.audio_url || null, aspect_ratio: body.aspect_ratio || "9:16", transition: body.transition || null, resolution: body.resolution || "720p", total_duration: body.total_duration || null }]),
    expires_at: expiresAt,
  });

  const result = await runVideocutJob(jobId, {
    images,
    audio_url: body.audio_url || null,
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
