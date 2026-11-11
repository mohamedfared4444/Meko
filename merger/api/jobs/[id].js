/**
 * GET /api/jobs/{id} — الحالة + التقدم (0–100) + الرابط عند الاكتمال
 * DELETE /api/jobs/{id} — حذف فوري شامل (jobs + sources + source_chunks + output_chunks)
 */

const { getJob, deleteJobCascade } = require("../../lib/db");

async function handler(req, res) {
  const id = req.query.id;
  if (!id) return sendError(res, 400, "معرّف المهمة مطلوب");

  if (req.method === "GET") {
    const job = await getJob(id);
    if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)");
    return res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }) && res.end(
      JSON.stringify({
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        videoUrl: job.video_url || undefined,
        downloadUrl: job.download_url || undefined,
        size: job.size || undefined,
        duration: job.duration || undefined,
        resolution: job.resolution || undefined,
        error: job.error || undefined,
        expiresAt: job.expires_at || undefined,
      }),
    );
  }

  if (req.method === "DELETE") {
    const job = await getJob(id);
    if (!job) return sendError(res, 404, "المهمة غير موجودة");
    await deleteJobCascade(id);
    return res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }) && res.end(JSON.stringify({ ok: true }));
  }

  return sendError(res, 405, "طريقة غير مسموحة — استخدم GET أو DELETE");
}

function sendError(res, status, message) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
}

module.exports = handler;
