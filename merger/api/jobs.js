/**
 * POST /api/jobs — إنشاء مهمة دمج.
 * يقبل {"videos":["url1","url2"]} أو
 * {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
 */

const crypto = require("crypto");
const { LIMITS, insertJob, cleanupExpired, getJob } = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return sendError(res, 405, "طريقة غير مسموحة — استخدم POST");
  }
  let body = null;
  try {
    body = await readJson(req);
  } catch {
    return sendError(res, 400, "جسم الطلب تالف — JSON صالح مطلوب");
  }

  const limits = {
    maxSources: LIMITS.MAX_SOURCES(),
    uploadChunkBytes: LIMITS.UPLOAD_CHUNK_BYTES,
  };

  let sources = [];
  if (body && Array.isArray(body.videos)) {
    sources = body.videos.map((u) => ({ kind: "url", url: String(u) }));
  } else if (body && Array.isArray(body.sources)) {
    sources = body.sources.map((s) => {
      const kind = s.kind === "file" ? "file" : "url";
      return kind === "file"
        ? { kind, name: String(s.name || "file.mp4"), size: Number(s.size || 0), mime: String(s.mime || "video/mp4") }
        : { kind, url: String(s.url || "") };
    });
  } else {
    return sendError(res, 400, 'الجسم يجب أن يحتوي {"videos":[...]} أو {"sources":[...]}');
  }

  if (sources.length === 0) {
    return sendError(res, 400, "لا توجد مقاطع — مرّر رابطًا واحدًا على الأقل");
  }
  if (sources.length > limits.maxSources) {
    return sendError(res, 400, `أقصى عدد مقاطع هو ${limits.maxSources}`);
  }
  for (const s of sources) {
    if (s.kind === "url") {
      if (!/^https?:\/\/.+/i.test(s.url)) {
        return sendError(res, 400, `رابط غير صالح: ${s.url || "(فارغ)"}`);
      }
    } else if (!s.size || s.size <= 0) {
      return sendError(res, 400, "المصادر المرفوعة تحتاج حجمًا صحيحًا (size بالبايت)");
    }
  }

  // تنظيف كسول للمهام المنتهية عند كل إنشاء
  void cleanupExpired().catch(() => {});

  const hasFiles = sources.some((s) => s.kind === "file");
  const jobId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  await insertJob({ id: jobId, status: hasFiles ? "uploading" : "queued", sources_json: JSON.stringify(sources), expires_at: expiresAt });

  const base = publicBase(req);
  const job = await getJob(jobId);
  const response = {
    jobId,
    status: job.status,
    statusUrl: `${base}/api/jobs/${jobId}`,
    processUrl: `${base}/api/jobs/${jobId}/process`,
    expiresAt,
  };
  if (hasFiles) {
    response.uploads = sources.map((s, i) =>
      s.kind === "file"
        ? { seq: i, url: `${base}/api/upload?job=${jobId}&seq=${i}`, uploadChunkBytes: limits.uploadChunkBytes }
        : { seq: i },
    );
  }
  res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(response));
};

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
      if (data.length > 1e6) reject(new Error("too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "null"));
      } catch (e) {
        // JSON.parse داخل معالج حدث لا يُلتقط بالخارج — نرفضها يدويًا حتى لا يسقط الخادم
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
