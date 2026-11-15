/**
 * POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن).
 * ينزّل/يسحب المصادر ← يرمّز ← يحفظ، ويرجع مباشرة:
 *   200 {"status":"done","videoUrl":...,"downloadUrl":...,"size":...,"duration":...,"resolution":"WxH","expiresAt":...}
 *   202 لو المهمة قيد المعالجة فعله
 *   فشل → 400/409/500 + {"error":"..."}
 */

const { runMergeJob } = require("../../../lib/merge");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "طريقة غير مسموحة — استخدم POST" }));
  }
  const id = req.query.id;
  if (!id) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "معرّف المهمة مطلوب" }));
  }

  const base = process.env.PUBLIC_BASE_URL
    ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, "")
    : `${req.headers["x-forwarded-proto"] || (String(req.headers.host || "").startsWith("localhost") || String(req.headers.host || "").startsWith("127.") ? "http" : "https")}://${req.headers["x-forwarded-host"] || req.headers.host}`;

  const result = await runMergeJob(id, base);

  if (result.status === 202) {
    res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ status: "processing", message: "المهمة قيد المعالجة بالفعل" }));
  }
  if (result.status === 200 && result.job) {
    const j = result.job;
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        status: "done",
        videoUrl: j.video_url,
        downloadUrl: j.download_url,
        size: j.size,
        duration: j.duration,
        resolution: j.resolution,
        expiresAt: j.expires_at,
      }),
    );
  }
  const status = result.status || 500;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: result.error || (result.job && result.job.error) || "فشل الدمج" }));
};
