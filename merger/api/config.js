/**
 * GET /api/config — الحدود العامة + version (تُستخدم لفحص الجهوزية)
 */

const { LIMITS } = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "طريقة غير مسموحة — استخدم GET" }));
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      version: "1.0.0",
      maxSources: LIMITS.MAX_SOURCES(),
      sourceMaxMB: LIMITS.SOURCE_MAX_MB(),
      outputMaxMB: LIMITS.OUTPUT_MAX_MB(),
      maxTotalDurationSec: LIMITS.MAX_TOTAL_DURATION_SEC(),
      uploadChunkBytes: LIMITS.UPLOAD_CHUNK_BYTES,
      retentionHours: 24,
      output: { container: "mp4", video: "libx264 CRF 18", audio: "aac 192k/44100Hz" },
    }),
  );
};
