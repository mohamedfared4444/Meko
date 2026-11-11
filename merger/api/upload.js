/**
 * POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB)
 * Content-Type: application/octet-stream — مع التحقق من حدود الحجم (413 عند التجاوز).
 */

const { getJob, getDb, LIMITS } = require("../lib/db");

const MAX_BODY = 5 * 1024 * 1024; // 4MB جزء + هامش

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return send(res, 405, { error: "طريقة غير مسموحة — استخدم POST" });
  }
  const jobId = String(req.query.job || "");
  const seq = Number(req.query.seq);
  const chunk = Number(req.query.chunk);
  if (!jobId || !Number.isInteger(seq) || !Number.isInteger(chunk)) {
    return send(res, 400, { error: "معطيات الرفع ناقصة: job و seq و chunk مطلوبة" });
  }

  const job = await getJob(jobId);
  if (!job) return send(res, 404, { error: "المهمة غير موجودة" });
  if (job.status === "processing" || job.status === "done") {
    return send(res, 409, { error: `لا يمكن الرفع في حالة المهمة الحالية (${job.status})` });
  }
  const sources = job.sources || [];
  if (seq < 0 || seq >= sources.length || sources[seq].kind !== "file") {
    return send(res, 400, { error: "seq لا يشير إلى مصدر ملف صالح" });
  }

  // قراءة الجسم الثنائي كاملًا مع حد الحجم
  const parts = [];
  let size = 0;
  let tooLarge = false;
  await new Promise((resolve) => {
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        req.destroy();
        resolve();
        return;
      }
      parts.push(Buffer.from(c));
    });
    req.on("end", resolve);
    req.on("error", resolve);
  });
  if (tooLarge) return send(res, 413, { error: "الجزء أكبر من الحد المسموح (4MB)" });
  const buf = Buffer.concat(parts);
  if (buf.length === 0) return send(res, 400, { error: "الجزء فارغ" });

  // حد حجم المصدر: الحجم المعلن + الحالي
  const declared = Number(sources[seq].size || 0);
  if (declared > LIMITS.SOURCE_MAX_MB() * 1048576) {
    return send(res, 413, { error: `حجم المصدر يتجاوز الحد ${LIMITS.SOURCE_MAX_MB()}MB` });
  }

  const db = getDb();
  await db.execute({
    sql: `INSERT OR REPLACE INTO source_chunks (job_id, source_seq, chunk_seq, data) VALUES (?,?,?,?)`,
    args: [jobId, seq, chunk, buf],
  });

  // تقدم الرفع: الحجم المرفوع الفعلي / الحجم المعلن
  const uploaded = await db.execute({
    sql: `SELECT COALESCE(SUM(length(data)),0) AS t FROM source_chunks WHERE job_id = ? AND source_seq = ?`,
    args: [jobId, seq],
  });
  const uploadedBytes = Number(uploaded.rows[0]?.t || 0);
  const allUploaded = declared > 0 ? uploadedBytes >= declared : true;

  // هل اكتمل رفع كل المصادر؟
  let complete = true;
  for (let i = 0; i < sources.length; i++) {
    if (sources[i].kind !== "file") continue;
    const r = await db.execute({
      sql: `SELECT COALESCE(SUM(length(data)),0) AS t FROM source_chunks WHERE job_id = ? AND source_seq = ?`,
      args: [jobId, i],
    });
    const got = Number(r.rows[0]?.t || 0);
    const need = Number(sources[i].size || 0);
    if (need > 0 ? got < need : got === 0) {
      complete = false;
      break;
    }
  }

  if (complete && job.status === "uploading") {
    await db.execute({ sql: `UPDATE jobs SET status = 'queued', updated_at = datetime('now') WHERE id = ?`, args: [jobId] });
  } else if (job.status === "queued") {
    await db.execute({ sql: `UPDATE jobs SET status = 'uploading', updated_at = datetime('now') WHERE id = ?`, args: [jobId] });
  }

  return send(res, 200, {
    ok: true,
    received: buf.length,
    uploadedBytes,
    sourceComplete: allUploaded,
    jobComplete: complete,
    status: complete ? "queued" : "uploading",
  });
};

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
