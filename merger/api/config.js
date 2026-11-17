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
      version: "1.2.0",
      maxSources: LIMITS.MAX_SOURCES(),
      sourceMaxMB: LIMITS.SOURCE_MAX_MB(),
      outputMaxMB: LIMITS.OUTPUT_MAX_MB(),
      maxTotalDurationSec: LIMITS.MAX_TOTAL_DURATION_SEC(),
      uploadChunkBytes: LIMITS.UPLOAD_CHUNK_BYTES,
      retentionHours: 24,
      output: { container: "mp4", video: "libx264 CRF 18", audio: "aac 192k/44100Hz" },
      codevideo: {
        endpoint: "/api/codevideo",
        contract: "html_code with window.renderAtTime(t, duration, wordTimings) → MP4 frames via headless Chromium + ffmpeg image2pipe",
        defaultDurationSec: 15,
        maxDurationSec: 60,
        defaultFps: 20,
        fpsRange: [8, 30],
        // Adaptive FPS: المشاهد ثقيلة تُخفَّض معدل إطاراتها تلقائيًا (حتى 12fps
        // وأدنى عند الحاجة) بدل الرفض — الرندر يكتمل دائمًا بلا فشل
        adaptiveFps: true,
        defaultAspect: {
          "9:16": "540x960",
          "16:9": "960x540",
          "1:1": "640x640",
        },
        defaultSize: "540x960",
        sizeRange: [240, 1280],
        // الرندر الكامل FHD 30fps — عامل GitHub Actions يرفع الناتج هنا
        // (render-complete) وتُحدَّث المهمة في Turso عبرنا
        fullRender: {
          engine: "github-actions workflow_dispatch render-code-video.yml",
          resolution: "1080x1920 (9:16) / 1920x1080 (16:9) / 1080x1080 (1:1)",
          fps: 30,
          endpoints: ["/api/render-payload", "/api/render-complete"],
        },
      },
    }),
  );
};
