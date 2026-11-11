/**
 * GET /api/jobs/{id}/video — بث الناتج بدعم Range (استجابة 206 + Content-Range)
 * ليعمل التقديم/الترجيع في المشغل. ?download=1 → تحميل مباشر.
 */

const { getJob, readBlobSize, streamBlobRange } = require("../../../lib/db");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "طريقة غير مسموحة — استخدم GET" }));
  }
  const id = req.query.id;
  const job = await getJob(id);
  if (!job) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)" }));
  }
  if (job.status !== "done") {
    res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: `الناتج غير جاهز — حالة المهمة: ${job.status}` }));
  }

  const total = await readBlobSize("output_chunks", ["job_id"], [id]);
  if (total === 0) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "ناتج المهمة غير موجود" }));
  }

  const headers = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
  };
  if (req.query.download === "1" || req.query.download === "true") {
    headers["Content-Disposition"] = `attachment; filename="merged-${id.slice(0, 8)}.mp4"`;
  }

  // تحليل ترويسة Range: bytes=start-end
  const rangeHeader = req.headers.range;
  let start = 0;
  let end = total - 1;
  let partial = false;
  if (rangeHeader) {
    const m = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
    if (m) {
      if (m[1] !== "" || m[2] !== "") {
        if (m[1] === "") {
          // لاحقة: bytes=-N → آخر N بايت
          const suffix = Number(m[2]);
          start = Math.max(0, total - suffix);
          end = total - 1;
        } else {
          start = Number(m[1]);
          end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
        }
        partial = true;
      }
      if (start > end || start >= total) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        return res.end();
      }
    }
  }

  if (partial) {
    headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
    headers["Content-Length"] = end - start + 1;
    res.writeHead(206, headers);
  } else {
    headers["Content-Length"] = total;
    res.writeHead(200, headers);
  }

  await streamBlobRange("output_chunks", ["job_id"], [id], start, end, async (buf) => {
    await new Promise((resolve, reject) => {
      res.write(buf, (e) => (e ? reject(e) : resolve()));
    });
  });
  res.end();
};
