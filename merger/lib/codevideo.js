/**
 * محرك الفيديو البرمجي (Code-Driven 2D Vector Motion Graphics) —
 * يحوّل صفحة HTML/CSS/SVG/JS ذاتية الاحتواء تحدد دالة عالمية
 * `window.renderAtTime(t, duration, wordTimings)` إلى فيديو MP4:
 *
 *  1) puppeteer-core + @sparticuz/chromium (متوافقة مع Vercel Serverless)
 *     تفتح الصفحة بمقاس الفيديو وتلتقط إطارًا لكل لحظة t من 0 حتى المدة،
 *     بعد استدعاء renderAtTime(t, duration, window.__wordTimings) في كل إطار
 *     (توقيتات الكلمات تُمرر من Meko حتى يتزامن الأنيميشن مع نطق كل كلمة).
 *  2) الإطارات تُضخ مباشرة عبر stdin (image2pipe/mjpeg) في ffmpeg-static
 *     أثناء الالتقاط — لا ملفات إطارات على القرص ولا تخزين كامل في الذاكرة.
 *  3) الصوت (audio_url MP3/WAV) يُدمج بترميز AAC، والفيديو H.264 yuv420p
 *     CRF 21 + faststart — الناتج يُخزَّن في output_chunks ويُخدم عبر
 *     /api/jobs/{id}/video بنفس صيغة مهام الدمج تمامًا.
 *
 * حماية الوقت والذاكرة (حد الدالة 60 ثانية):
 *  - ميزانية التقاط إطارات صارمة (FRAME_TIME_BUDGET_MS): بعد أول 3 إطارات
 *    نقيس زمن الإطار الواحد؛ إن كان المشروع لن يكتمل في الميزانية خُفّض
 *    معدل الإطارات تلقائيًا (حتى 8fps) — والصوت يبقى متزامنًا لأن المعدل
 *    الفعلي (frames/duration) هو الممر لـ ffmpeg وليس المعدل المطلوب.
 *  - ساعة إنذار كلية (RENDER_HARD_BUDGET_MS) تقتل العملية برسالة واضحة.
 *  - مقاس افتراضي 720×1280 (أسرع من 1080 مع جودة كافية للشورتس/ريلز).
 *
 * الخطوط: بيئة lambda بلا أي خطوط نظام — نضخ خطي Noto Sans Arabic
 * (العربية بأشكال اتصال كاملة عبر HarfBuzz في Chromium نفسه) وLiberation
 * Sans (اللاتينية) كـ @font-face data URIs في رأس الصفحة قبل أول إطار،
 * فتظهر النصوص العربية/الإنجليزية صحيحة في أي HTML من غير تضمين خطوط.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { LIMITS, updateJob, saveBlobRows } = require("./db");
const { ensureExecutable, ffmpegBin } = require("./merge");

// ---------------------------------------------------------------------------
// الثوابت والحدود

const DEFAULT_DURATION = 15;
const MAX_DURATION = 60;
const DEFAULT_FPS = 24;
const MIN_FPS = 8;
const MAX_FPS = 30;
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 1280;
const MIN_SIZE = 240;
const MAX_SIZE = 1280;
/** حد طول كود HTML الواحد (يحمي الذاكرة وحجم الجسم 4.5MB في Vercel) */
const MAX_HTML_CHARS = 300_000;
/** ميزانية التقاط الإطارات — داخل حد الدالة 60 ثانية بهامش للترميز والرفع */
const FRAME_TIME_BUDGET_MS = Number(process.env.CODEVIDEO_FRAME_BUDGET_MS) || 30_000;
/** ساعة الإنذار الكلية لعملية الرندر (تقتل كل شيء برسالة واضحة) */
const RENDER_HARD_BUDGET_MS = Number(process.env.CODEVIDEO_HARD_BUDGET_MS) || 52_000;
/** جودة لقطات JPEG — 85 توازن ممتاز بين الحجم والسرعة والجودة للرسومات المتجهة */
const SCREENSHOT_QUALITY = Number(process.env.CODEVIDEO_JPEG_QUALITY) || 85;
/** أقصى عدد إدخالات توقيتات الكلمات المقبولة */
const MAX_WORD_TIMINGS = 5000;

/** خطوط عربي/لاتيني مضمّنة مع الخدمة — تُضخ كـ @font-face داخل الصفحة نفسها
 *  (نفس خطوط الترجمة في videocut: Noto Sans Arabic + Liberation Sans) */
const FONT_FILES = {
  "MekoArabic": path.join(__dirname, "..", "fonts", "NotoSansArabic-Regular.ttf"),
  "MekoLatin": path.join(__dirname, "..", "fonts", "LiberationSans-Regular.ttf"),
};
const FONT_DATA_URIS = {};
for (const [family, file] of Object.entries(FONT_FILES)) {
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length > 1000) {
      FONT_DATA_URIS[family] = `data:font/ttf;base64,${bytes.toString("base64")}`;
    }
  } catch {
    /* على الاستضافة المحلية قد يغيب الخط — نكمل بخطوط النظام/المتصفح */
  }
}

// ‌Vercel NFT tracing: أرشيفات bin في @sparticuz/chromium تُكتشف ديناميكيًا
// (readdirSync) فلا يتبعها مُتتبع NFT وتبقى خارج حزمة الدالة — وبغياب أرشيف
// المكتبات يفشل Chromium بـ «libnss3.so cannot open». قراءة صريحة بأسماء
// ثابتة تجبر NFT على تضمين كل الأرشيفات في الحزمة.
const CHROMIUM_BIN_DIR = path.join(__dirname, "..", "node_modules", "@sparticuz/chromium", "bin");
for (const binFile of ["al2.tar.br", "al2023.tar.br", "chromium.br", "fonts.tar.br", "swiftshader.tar.br"]) {
  try {
    fs.readFileSync(path.join(CHROMIUM_BIN_DIR, binFile));
  } catch {
    /* ملف غير موجود في هذا الإصدار — تجاهل بهدوء */
  }
}

// ---------------------------------------------------------------------------
// أدوات

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 30000) stderr = stderr.slice(-30000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`(ffmpeg) خرج بكود ${code}: ${stderr.slice(-600)}`));
    });
  });
}

/** مدة ملف صوت بالثواني — عبر ffmpeg نفسه (بلا ffprobe لتقليل حجم الحزمة):
 *  سطر «Duration: 00:00:12.34» من مخرجات ffmpeg الداخلية دقيق إلى سنتيسكند */
async function audioDurationSec(ffmpegPath, filePath) {
  try {
    const { stderr } = await run(ffmpegPath, ["-hide_banner", "-i", filePath, "-f", "null", "-"]);
    const m = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{2})/);
    if (m) {
      const d = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
      if (Number.isFinite(d) && d > 0.05) return d;
    }
  } catch {
    /* نقع في التقدير */
  }
  // تقدير احتياطي من حجم الملف (صوت 48kbit mono مثل ناتج Edge-TTS)
  const st = await fs.promises.stat(filePath);
  return Math.max(1, (st.size * 8) / 48_000);
}

/** تنزيل ملف إلى مسار — fetch مع حد حجم صرف (الصوت فقط: MP3/WAV) */
async function downloadAudio(url, destPath, maxBytes) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`تعذر تنزيل الصوت (${res.status}): ${String(url).slice(0, 120)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(`حجم الصوت (${(buf.length / 1048576).toFixed(1)}MB) يتجاوز الحد ${(maxBytes / 1048576).toFixed(0)}MB`);
  }
  if (buf.length < 512) throw new Error("ملف الصوت غير صالح أو فارغ");
  const head = buf.subarray(0, 512).toString("latin1").trim().toLowerCase();
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || ct.includes("text/html")) {
    throw new Error(`رابط الصوت يعيد صفحة HTML بدل الملف الخام (content-type: ${ct || "بلا نوع"}) — انتهت صلاحية الرابط: ${String(url).slice(0, 120)}`);
  }
  await fs.promises.writeFile(destPath, buf);
  return buf.length;
}

/**
 * بناء وسم <style> يضخ الخطوط المضمّنة كـ @font-face مع سلسلة خطوط افتراضية
 * للصفحة كلها — الـ @font-face لا يفرض نفسه على أي عنصر صممه Claude صراحة،
 * لكن السلسلة الافتراضية تضمن العربية والإنجليزية حتى بلا أي خط مضبوط.
 */
function buildFontStyleTag() {
  const faces = Object.entries(FONT_DATA_URIS)
    .map(([family, uri]) => `@font-face{font-family:'${family}';src:url('${uri}') format('truetype');font-weight:normal;font-style:normal;font-display:block;}`)
    .join("");
  const chain = Object.keys(FONT_DATA_URIS);
  const fallback = chain.length > 0
    ? `html,body{font-family:${chain.map((f) => `'${f}'`).join(",")},system-ui,-apple-system,'Segoe UI',sans-serif;}`
    : "";
  if (!faces && !fallback) return "";
  return `<style data-meko-fonts>${faces}${fallback}</style>`;
}

/** حقن وسم الخطوط في HTML — قبل </head> إن وُجد وإلا في أول الصفحة */
function injectFonts(html) {
  const tag = buildFontStyleTag();
  if (!tag) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => `${m}${tag}`);
  return tag + html;
}

/** تنقية توقيتات الكلمات القادمة من Meko — أرقام سليمة مرتبة زمنيًا */
function sanitizeWordTimings(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const list = raw
    .slice(0, MAX_WORD_TIMINGS)
    .map((w) => {
      const o = w && typeof w === "object" ? w : {};
      const start = Number(o.start);
      const end = Number(o.end);
      const text = typeof o.text === "string" ? o.text.slice(0, 200) : "";
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !text) return null;
      return { start: Math.max(0, start), end: Math.max(0, end), text };
    })
    .filter(Boolean);
  if (list.length < 2) return null;
  list.sort((a, b) => a.start - b.start);
  return list;
}

/** إطلاق Chromium (مرة واحدة لكل مهمة) مع أمانات بيئة serverless */
async function launchBrowser(width, height) {
  const chromium = require("@sparticuz/chromium");
  const puppeteer = require("puppeteer-core");
  const executablePath = await chromium.executablePath();
  await ensureExecutable(executablePath).catch(() => {});
  return puppeteer.launch({
    args: [...chromium.args, "--font-render-hinting=none", "--hide-scrollbars"],
    defaultViewport: { width, height },
    executablePath,
    headless: chromium.headlessMode ?? true,
    protocolTimeout: 20_000,
  });
}

// ---------------------------------------------------------------------------
// تنفيذ المهمة — متزامنة داخل الطلب

async function runCodeVideoJob(jobId, spec) {
  const width = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(Number(spec.width) || DEFAULT_WIDTH)));
  const height = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(Number(spec.height) || DEFAULT_HEIGHT)));
  const requestedFps = Math.max(MIN_FPS, Math.min(MAX_FPS, Math.round(Number(spec.fps) || DEFAULT_FPS)));
  const wordTimings = sanitizeWordTimings(spec.word_timings);
  const html = injectFonts(String(spec.html_code ?? ""));

  await updateJob(jobId, { status: "processing", progress: 2, error: null });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codevid-${jobId}-`));
  const outputPath = path.join(tmpDir, "output.mp4");
  const ffmpeg = await ffmpegBin();

  let browser = null;
  let ffmpegChild = null;
  const startedAt = Date.now();
  const hardDeadline = startedAt + RENDER_HARD_BUDGET_MS;

  try {
    // 1) الصوت أولًا — فشله يُفشل المهمة قبل أي تكلفة Chromium (مدته = مدة الفيديو)
    let audioPath = null;
    let audioDur = 0;
    if (spec.audio_url && /^(https?:\/\/|data:audio\/)/i.test(String(spec.audio_url))) {
      audioPath = path.join(tmpDir, "audio.bin");
      if (/^data:audio\//i.test(String(spec.audio_url))) {
        const b64 = String(spec.audio_url).slice(String(spec.audio_url).indexOf(",") + 1);
        const buf = Buffer.from(b64, "base64");
        if (buf.length < 512) throw new Error("ملف صوت data: تالف");
        await fs.promises.writeFile(audioPath, buf);
      } else {
        await downloadAudio(spec.audio_url, audioPath, 40 * 1048576);
      }
      audioDur = await audioDurationSec(ffmpeg, audioPath);
      await updateJob(jobId, { progress: 6 });
    }

    // 2) المدة: مدة الصوت الفعلية هي المرجع عند وجوده (مزامنة تلقائية)،
    //    وإلا duration_seconds من الطلب (افتراضي 15، أقصى 60)
    const duration = audioDur > 0
      ? Math.min(MAX_DURATION * 2, audioDur) // الصوت الأطول من 120 ثانية يُقص
      : Math.max(1, Math.min(MAX_DURATION, Math.round(Number(spec.duration_seconds) || DEFAULT_DURATION)));

    // 3) فتح الصفحة والتحقق من العقد (renderAtTime موجودة وقابلة للاستدعاء)
    browser = await launchBrowser(width, height);
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(15_000);
    await page.setContent(html, { waitUntil: "load" });
    const hasRender = await page.evaluate(() => typeof window.renderAtTime === "function" || typeof window.__renderAtTime === "function");
    if (!hasRender) {
      throw new Error('صفحة HTML لا تعرّف الدالة العالمية المطلوبة window.renderAtTime(t, duration, wordTimings) — أضفها في وسم <script> داخل الصفحة.');
    }
    if (wordTimings) {
      await page.evaluate((wt) => { window.__wordTimings = wt; }, wordTimings);
    }
    // تسخين آمن: نداء واحد بمدة الفيديو الحقيقية كي لا يرمي renderAtTime خطأً
    // (الكود الذي يقسم على duration يجب أن يستقبل قيمة سليمة منذ النداء الأول)
    await page.evaluate((d) => {
      try {
        window.renderAtTime && window.renderAtTime(0, d, window.__wordTimings);
      } catch (e) {
        window.__mekoRenderError = String((e && e.message) || e);
      }
    }, duration);
    const warmError = await page.evaluate(() => window.__mekoRenderError || null);
    if (warmError) throw new Error(`renderAtTime ألقت خطأً عند t=0: ${warmError.slice(0, 300)}`);

    // 4) قياس زمن الإطار الفعلي وخفض معدل الإطارات تلقائيًا عند الحاجة —
    //    الصوت يبقى متزامنًا لأن ffmpeg يستقبل المعدل الفعلي frames/duration
    const t0 = Date.now();
    for (let probe = 0; probe < 3; probe++) {
      const tProbe = (probe * duration) / 3;
      await page.evaluate((t, d) => window.renderAtTime(t, d, window.__wordTimings), tProbe, duration);
      await page.screenshot({ type: "jpeg", quality: SCREENSHOT_QUALITY, captureBeyondViewport: false, optimizeForSpeed: true });
    }
    const perFrameMs = Math.max(15, (Date.now() - t0) / 3);
    const framesByBudget = Math.floor(FRAME_TIME_BUDGET_MS / perFrameMs);
    let frames = Math.max(MIN_FPS, Math.min(MAX_FPS, requestedFps)) * duration; // المطلوب
    frames = Math.round(Math.min(frames, framesByBudget, MAX_FPS * MAX_DURATION));
    if (frames < Math.max(8, duration * MIN_FPS * 0.5)) {
      throw new Error(`المشهد أبطأ من ميزانية الوقت (زمن الإطار ${Math.round(perFrameMs)}ms) — قلّل تفاصيل الأنيميشن أو قصّر المدة (${duration} ثانية).`);
    }
    const actualFps = Math.max(MIN_FPS - 0.001, Math.min(MAX_FPS, frames / duration)); // المعدل الفعلي الممر لـ ffmpeg
    if (requestedFps !== Math.round(actualFps)) {
      console.warn(`[codevideo:${jobId}] خُفّض معدل الإطارات ${requestedFps}→${actualFps.toFixed(2)}fps ليلائم ميزانية الوقت (زمن الإطار ${Math.round(perFrameMs)}ms)`);
    }
    await updateJob(jobId, { progress: 10 });

    // 5) بناء أمر ffmpeg — الإطارات تُضخ عبر stdin (image2pipe) أثناء الالتقاط
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats"];
    args.push("-f", "image2pipe", "-framerate", actualFps.toFixed(4), "-i", "-"); // مدخل 0: الإطارات
    let audioInput = -1;
    if (audioPath) {
      args.push("-i", audioPath); // مدخل 1: الصوت
      audioInput = 1;
    } else {
      args.push("-f", "lavfi", "-t", duration.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
      audioInput = 1;
    }
    args.push("-map", "0:v:0", "-map", `${audioInput}:a:0`);
    args.push("-c:v", "libx264", "-crf", "21", "-preset", process.env.CODEVIDEO_PRESET || "veryfast", "-pix_fmt", "yuv420p", "-r", actualFps.toFixed(4));
    args.push("-c:a", "aac", "-b:a", "192k", "-ar", "44100");
    // قص دقيق على مدة الصوت/المطلوبة — لا تلاشي زائد ولا إطارات مجمدة في النهاية
    args.push("-t", duration.toFixed(3), "-movflags", "+faststart");
    args.push(outputPath);

    ffmpegChild = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
    let ffmpegErr = "";
    ffmpegChild.stderr.on("data", (d) => {
      ffmpegErr += d.toString();
      if (ffmpegErr.length > 20000) ffmpegErr = ffmpegErr.slice(-20000);
    });
    const ffmpegClosed = new Promise((resolve, reject) => {
      ffmpegChild.on("error", reject);
      ffmpegChild.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`(ffmpeg) خرج بكود ${code}: ${ffmpegErr.slice(-600)}`));
      });
    });

    // 6) حلقة الالتقاط — renderAtTime(t) ثم لقطة JPEG تُكتب في stdin مباشرة
    //    مع احترام الضغط العكسي (backpressure) كي لا تتضخم الذاكرة أبدًا
    let captured = 0;
    const capture = (async () => {
      for (let i = 0; i < frames; i++) {
        if (Date.now() > hardDeadline) {
          throw new Error(`تجاوز مهلة الرندر الصارمة (${Math.round(RENDER_HARD_BUDGET_MS / 1000)} ثانية) بعد ${captured}/${frames} إطارًا — قلّل تفاصيل المشهد.`);
        }
        const t = (i * duration) / frames;
        await page.evaluate((tt, d) => window.renderAtTime(tt, d, window.__wordTimings), t, duration);
        const buf = await page.screenshot({ type: "jpeg", quality: SCREENSHOT_QUALITY, captureBeyondViewport: false, optimizeForSpeed: true });
        if (!ffmpegChild.stdin.write(buf)) {
          await new Promise((resolve) => ffmpegChild.stdin.once("drain", resolve));
        }
        captured++;
        // التقدم 10→85 موزع على الإطارات (الترميز يجري بالتوازي)
        if (i % 8 === 0 || i === frames - 1) {
          void updateJob(jobId, { progress: Math.round(10 + 75 * ((i + 1) / frames)) }).catch(() => {});
        }
      }
      ffmpegChild.stdin.end();
    })();

    // أي من الاثنين يفشل يُسقط المهمة — وساعة الإنذار تحمي من التعليق الأبدي
    const watchdog = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`تجاوز مهلة الرندر الصارمة (${Math.round(RENDER_HARD_BUDGET_MS / 1000)} ثانية) — أُوقفت العملية تلقائيًا.`)), RENDER_HARD_BUDGET_MS);
    });
    await Promise.race([Promise.all([capture, ffmpegClosed]), watchdog]);

    // 7) التحقق من الناتج وتخزينه بنفس نظام مهام الدمج (92–100%)
    const st = await fs.promises.stat(outputPath);
    if (st.size > LIMITS.OUTPUT_MAX_MB() * 1048576) {
      throw new Error(`حجم الناتج (${(st.size / 1048576).toFixed(1)}MB) يتجاوز الحد`);
    }
    await updateJob(jobId, { progress: 93 });
    const blob = await fs.promises.readFile(outputPath);
    await saveBlobRows("output_chunks", ["job_id"], [jobId], blob);

    const base = String(spec._publicBase || "").replace(/\/+$/, "");
    const videoUrl = `${base}/api/jobs/${jobId}/video`;
    const downloadUrl = `${base}/api/jobs/${jobId}/video?download=1`;
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
    await updateJob(jobId, {
      status: "done",
      progress: 100,
      video_url: videoUrl,
      download_url: downloadUrl,
      size: st.size,
      duration: Number(duration.toFixed(2)),
      resolution: `${width}x${height}`,
      expires_at: expiresAt,
      error: null,
    });

    return {
      httpStatus: 200,
      jobId,
      status: "done",
      video_url: videoUrl,
      download_url: downloadUrl,
      duration: Number(duration.toFixed(2)),
      resolution: `${width}x${height}`,
      fps: Number(actualFps.toFixed(2)),
      requested_fps: requestedFps,
      frames: captured,
      size: st.size,
      had_audio: !!audioPath,
      had_word_timings: !!wordTimings,
      expiresAt,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (ffmpegChild && ffmpegChild.exitCode === null) {
      try { ffmpegChild.kill("SIGKILL"); } catch { /* تجاهل */ }
    }
    await updateJob(jobId, { status: "failed", error: msg.slice(0, 500) }).catch(() => {});
    return { httpStatus: 500, status: "failed", error: msg.slice(0, 800) };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* تجاهل */ }
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { runCodeVideoJob, injectFonts, sanitizeWordTimings, audioDurationSec };
