/**
 * عامل الرندر الكامل لفيديو الأنيميشن البرمجي — يعمل على GitHub Actions
 * (ubuntu-latest) خارج قيود Vercel Serverless:
 *
 *  - يقرأ الحمولة (كود المشهد + الصوت + توقيتات الكلمات) من meko-manger
 *    عبر payload_url، أو من مدخل html_code_b64 للمشاهد الصغيرة.
 *  - يرندر كل الإطارات بمعدل fps ثابت حقيقي (افتراضي 30، بلا أي تخفيض تكيفي)
 *    وبأبعاد FHD كاملة (افتراضي 1080×1920) عبر Chromium (puppeteer-core +
 *    كروم النظام) ثم يضخ الإطارات عبر stdin في FFmpeg (H.264 CRF 18).
 *  - ملء الكادر تلقائيًا: يقيس المقاس الطبيعي للمشهد (svg/canvas/حاوية الجسم)
 *    مهما كان مقاس التصميم (720×1280، 540×960…) ويكبّره ليملأ 100% من الإطار
 *    الهدف بلا فراغات سوداء — عبر deviceScaleFactor (رسم بدقة أعلى) عند توافق
 *    الأبعاد، وإلا تحويل CSS موحد مع توسيط (اقتصاص ≤15%) أو حشو بخلفية المشهد.
 *  - الصوت: يدعم الروابط http/data: (المضمّن يُفك محليًا) مع محاولتي تنزيل
 *    وترويسة متصفح، ويُدمج مسار صوت AAC دائمًا (حتى الصامت anullsrc)، ثم يتحقق
 *    بـ ffprobe من الناتج: الأبعاد والمعدل والمدة ووجود مسار الصوت فعليًا.
 *  - يرفع MP4 مجزأً إلى meko-manger /api/render-complete (op=chunk ثم
 *    op=finalize) فتُحدَّث المهمة في Turso: status=completed, progress=100,
 *    video_url=/api/jobs/{job_id}/video.
 *  - عند فشل الرفع إلى meko-manger: يرفع الفيديو إلى إصدار GitHub (دائم)
 *    ويحدّث المهمة برابط الإصدار، وإن تعذر ذلك وكانت أسرار Turso مضبوطة
 *    يحدّث Turso مباشرة.
 *  - أي فشل يُعلَّم على المهمة (op=failed أو Turso مباشرة) — لا تُترك مهمة
 *    عالقة أبدًا.
 *
 * المدخلات (env من الـ workflow): INPUT_TASK_ID, INPUT_JOB_ID,
 * INPUT_PAYLOAD_URL, INPUT_HTML_CODE_B64, INPUT_AUDIO_URL,
 * INPUT_WORD_TIMINGS_JSON, INPUT_WIDTH, INPUT_HEIGHT, INPUT_FPS,
 * INPUT_DURATION — وMERGER_BASE_URL وTURSO_DATABASE_URL/TURSO_AUTH_TOKEN
 * (اختياريان) وGH_TOKEN/REPO_NAME (من Actions تلقائيًا).
 *
 * وضع ثانٍ: `node scripts/render-code-video.js --fail "رسالة"` — يعلّم المهمة
 * فاشلة (يستخدمه خطوة if: failure() في الـ workflow).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

// ---------------------------------------------------------------------------
// إعدادات ومدخلات

const MERGER_BASE = (process.env.MERGER_BASE_URL || "https://meko-manger.vercel.app").replace(/\/+$/, "");
// task_id/job_id = "new" (مشغّل يدوي): تُنشأ مهمة جديدة عبر op=provision ثم تُستخدم معرفاتها
let TASK_ID = String(process.env.INPUT_TASK_ID || "").trim();
let JOB_ID = String(process.env.INPUT_JOB_ID || "").trim();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1920;
const DEFAULT_FPS = 30;
const DEFAULT_DURATION = 15;
const MAX_DURATION = 300; // سقف أمان — العامل يتحمل دقائق عدة
const MAX_WORD_TIMINGS = 5000;
const CHUNK_BYTES = 2 * 1024 * 1024; // أجزاء الرفع ≤2MB (حد الخدمة 2.5MB بهامش)
const PROGRESS_VIDEO_PATH = "/tmp/code-video-final.mp4"; // نفس مسار الـ Artifact

const log = (msg) => console.log(`[render] ${msg}`);

// ---------------------------------------------------------------------------
// أوضاع التشغيل

if (process.argv[2] === "--fail") {
  markFailed(String(process.argv[3] || "فشل الرندر الكامل.")).then((ok) => process.exit(ok ? 0 : 1));
} else {
  main().catch(async (e) => {
    console.error("[render] فشل استثناء:", e instanceof Error ? e.stack : String(e));
    await markFailed(e instanceof Error ? e.message.slice(0, 450) : String(e).slice(0, 450));
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// الوضع الرئيسي

async function main() {
  if ((TASK_ID === "new") !== (JOB_ID === "new")) {
    throw new Error('task_id و job_id يجب أن يكونا معًا "new" (إنشاء مهمة جديدة) أو معرفين UUID صالحين');
  }
  if (TASK_ID !== "new" && (!UUID_RE.test(TASK_ID) || !UUID_RE.test(JOB_ID))) {
    throw new Error("INPUT_TASK_ID و INPUT_JOB_ID مطلوبان بصيغة UUID صالحة أو \"new\" لإنشاء مهمة جديدة");
  }

  // 1) الحمولة: رابط من meko-manger (أساسي) أو base64 من المدخلات
  const payload = await loadPayload();
  if (TASK_ID === "new") {
    const prov = await provisionTask(payload);
    TASK_ID = prov.task_id;
    JOB_ID = prov.job_id;
    log(`مهمة جديدة أُنشئت عبر provision: ${TASK_ID} — مهمة الدمج ${JOB_ID}`);
  }
  const startedAt = Date.now();
  const html = String(payload.html_code || "");
  if (html.trim().length < 100 || !/renderAtTime/.test(html)) {
    throw new Error("كود المشهد غير صالح — يجب أن يكون صفحة HTML ذاتية الاحتواء تعرّف window.renderAtTime(t, duration, wordTimings)");
  }

  // 2) الأبعاد والمعدل والمدة — مدخلات الـ workflow تُقدّم ثم الحمولة ثم الافتراضي
  const width = clampEven(Number(process.env.INPUT_WIDTH) || Number(payload.width) || DEFAULT_WIDTH, 240, 2560);
  const height = clampEven(Number(process.env.INPUT_HEIGHT) || Number(payload.height) || DEFAULT_HEIGHT, 240, 2560);
  const fps = Math.max(1, Math.min(60, Math.round(Number(process.env.INPUT_FPS) || Number(payload.fps) || DEFAULT_FPS)));
  let duration = Math.max(1, Math.min(MAX_DURATION, Number(process.env.INPUT_DURATION) || Number(payload.duration_seconds) || DEFAULT_DURATION));
  const wordTimings = sanitizeTimings(process.env.INPUT_WORD_TIMINGS_JSON ? JSON.parse(process.env.INPUT_WORD_TIMINGS_JSON) : payload.word_timings);

  // 3) الصوت — وجوده يجعل مدته هي المرجع (مزامنة تلقائية)
  const audioUrl = String(process.env.INPUT_AUDIO_URL || payload.audio_url || "").trim() || null;
  let audioPath = null;
  if (audioUrl) {
    audioPath = await downloadAudio(audioUrl);
    const d = await audioDurationSec(audioPath);
    if (d > 0.5) duration = Math.min(MAX_DURATION, d);
    log(`الصوت جاهز — مدته ${duration.toFixed(2)} ثانية`);
  } else {
    log(`فيديو صام — المدة ${duration.toFixed(2)} ثانية`);
  }

  await pingProgress(12);
  await writeSummary(`**الرندر الكامل**: ${width}×${height} @ ${fps}fps — ${duration.toFixed(1)}s — ${Math.round(fps * duration)} إطارًا${audioPath ? " — مع صوت" : " — صامت"}`);

  // 4) الرندر — كل الإطارات بمعدل ثابت حقيقي، بلا أي تخفيض
  const render = await renderVideo({ html, width, height, fps, duration, wordTimings, audioPath });
  log(`الرندر اكتمل: ${render.frames} إطارًا — ${render.size} بايت — ${((Date.now() - startedAt) / 1000).toFixed(0)} ثانية`);

  // 5) النشر: أجزاء إلى meko-manger ثم finalize (يحدّث Turso)
  const published = await publishToMerger({ width, height, fps, duration, frames: render.frames, size: render.size });
  if (published) {
    await writeSummary(`**الناتج**: ${published.videoUrl}`);
    log(`تم النشر عبر meko-manger — المهمة مكتملة: ${published.videoUrl}`);
    return;
  }

  // 6) الاحتياط: إصدار GitHub (دائم) ثم finalize برابط خارجي أو Turso مباشرة
  log("فشل الرفع إلى meko-manger — المحاولة عبر إصدار GitHub…");
  const releaseUrl = await uploadToRelease();
  if (releaseUrl) {
    const viaOverride = await finalizeToMerger({ width, height, fps, duration, frames: render.frames, size: render.size, video_url_override: releaseUrl });
    if (viaOverride) {
      await writeSummary(`**الناتج (إصدار GitHub)**: ${releaseUrl}`);
      log(`تم النشر عبر إصدار GitHub: ${releaseUrl}`);
      return;
    }
    const viaTurso = await updateTaskDirectTurso({ videoUrl: releaseUrl, width, height, fps, duration, frames: render.frames });
    if (viaTurso) {
      log(`تم تحديث Turso مباشرة برابط الإصدار: ${releaseUrl}`);
      return;
    }
  }
  throw new Error("فشل كل مسارات النشر (meko-manger ثم إصدار GitHub ثم Turso المباشر)");
}

// ---------------------------------------------------------------------------
// إنشاء مهمة جديدة (المشغّل اليدوي — task_id="new")

async function provisionTask(payload) {
  const res = await fetchWithTimeout(
    `${MERGER_BASE}/api/render-complete?op=provision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        html_code: String(payload.html_code || ""),
        title: String(payload.title || "فيديو برمجي — رندر كامل"),
        width: Number(process.env.INPUT_WIDTH) || Number(payload.width) || DEFAULT_WIDTH,
        height: Number(process.env.INPUT_HEIGHT) || Number(payload.height) || DEFAULT_HEIGHT,
        fps: Number(process.env.INPUT_FPS) || Number(payload.fps) || DEFAULT_FPS,
        duration_seconds: Number(process.env.INPUT_DURATION) || Number(payload.duration_seconds) || DEFAULT_DURATION,
        audio_url: String(process.env.INPUT_AUDIO_URL || payload.audio_url || "") || null,
        word_timings: payload.word_timings || null,
      }),
    },
    30_000,
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`فشل provision (HTTP ${res.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// الحمولة

async function loadPayload() {
  const payloadUrl = String(process.env.INPUT_PAYLOAD_URL || "").trim();
  if (payloadUrl && /^https?:\/\//i.test(payloadUrl)) {
    const res = await fetchWithTimeout(payloadUrl, {}, 60_000);
    if (!res.ok) throw new Error(`تعذر جلب الحمولة (${res.status}) من ${payloadUrl}`);
    const p = await res.json();
    log(`الحمولة جُلبت من meko-manger (${(JSON.stringify(p).length / 1024).toFixed(1)}KB)`);
    return p;
  }
  const b64 = String(process.env.INPUT_HTML_CODE_B64 || "").trim();
  if (b64) {
    const html = Buffer.from(b64, "base64").toString("utf8");
    log(`كود المشهد من مدخل base64 (${(html.length / 1024).toFixed(1)}KB)`);
    return { html_code: html };
  }
  throw new Error("لا payload_url ولا html_code_b64 — لا يمكن تحديد كود المشهد");
}

// ---------------------------------------------------------------------------
// الرندر

async function renderVideo({ html, width, height, fps, duration, wordTimings, audioPath }) {
  const ffmpeg = await ensureFfmpeg();
  const browser = await launchBrowser(width, height);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codevid-"));
  const outputPath = path.join(tmpDir, "output.mp4");
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60_000);
    await page.setContent(injectFonts(html), { waitUntil: "load" });

    const hasRender = await page.evaluate(() => typeof window.renderAtTime === "function" || typeof window.__renderAtTime === "function");
    if (!hasRender) {
      throw new Error('صفحة HTML لا تعرّف window.renderAtTime(t, duration, wordTimings) — أضفها في <script> داخل الصفحة.');
    }
    if (wordTimings) {
      await page.evaluate((wt) => { window.__wordTimings = wt; }, wordTimings);
    }
    // نداء تسخين بالمدة الحقيقية كي لا يرمي renderAtTime خطأ عند التقسيم على المدة
    await page.evaluate((d) => {
      try {
        window.renderAtTime && window.renderAtTime(0, d, window.__wordTimings);
      } catch (e) {
        window.__mekoRenderError = String((e && e.message) || e);
      }
    }, duration);
    const warmError = await page.evaluate(() => window.__mekoRenderError || null);
    if (warmError) throw new Error(`renderAtTime ألقت خطأً عند t=0: ${warmError.slice(0, 300)}`);

    // ملء الكادر: اكتشاف مقاس المشهد الطبيعي وتكبيره ليملأ 100% من الإطار
    // (المشاهد المصممة 720×1280 أو 540×960 تظهر صغيرة بزاوية الإطار دونه)
    const fit = await fitStageToFrame(page, width, height);
    if (fit) {
      log(`ملء الكادر: المشهد ${fit.naturalW}×${fit.naturalH} → ${width}×${height} عبر ${fit.strategy} (scale=${fit.scale.toFixed(3)})`);
      await writeSummary(`**ملء الكادر**: المشهد ${fit.naturalW}×${fit.naturalH} → ${width}×${height} — ${fit.strategy === "viewport-dsf" ? "تكبير بدقة أعلى (deviceScaleFactor)" : fit.strategy === "transform-cover" ? "تحويل CSS مع اقتصاص طفيف للمواءمة" : "تحويل CSS مع حشو بخلفية المشهد"} (scale ${fit.scale.toFixed(3)})`);
    }

    // أمر ffmpeg — الإطارات تُضخ عبر stdin أثناء الالتقاط (بلا ملفات وسيطة)
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats"];
    args.push("-f", "image2pipe", "-framerate", String(fps), "-i", "-");
    if (audioPath) {
      args.push("-i", audioPath);
    } else {
      args.push("-f", "lavfi", "-t", duration.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
    }
    args.push("-map", "0:v:0", "-map", "1:a:0");
    // veryfast: ذاكرة أقل بكثير من medium بنفس الجودة البصرية تقريبًا عند CRF 18
    // (قابل للضبط بـ FFMPEG_X264_PRESET للبيئات الغنية بالذاكرة)
    args.push("-c:v", "libx264", "-crf", "18", "-preset", process.env.FFMPEG_X264_PRESET || "veryfast", "-pix_fmt", "yuv420p", "-r", String(fps));
    args.push("-c:a", "aac", "-b:a", "192k", "-ar", "44100");
    args.push("-t", duration.toFixed(3), "-movflags", "+faststart");
    args.push(outputPath);

    const child = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
    let ffmpegErr = "";
    child.stderr.on("data", (d) => {
      ffmpegErr += d.toString();
      if (ffmpegErr.length > 20000) ffmpegErr = ffmpegErr.slice(-20000);
    });
    const closed = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg خرج بكود ${code}: ${ffmpegErr.slice(-600)}`))));
    });

    const frames = Math.round(fps * duration); // معدل ثابت حقيقي — بلا أي تخفيض
    let captured = 0;
    let lastPing = -1;
    for (let i = 0; i < frames; i++) {
      const t = (i * duration) / frames; // == i / fps بالضبط
      await page.evaluate((tt, d) => window.renderAtTime(tt, d, window.__wordTimings), t, duration);
      // PNG بلا فقد — جودة كاملة على عامل قوي بلا قيود زمن
      const buf = await page.screenshot({ type: "png", captureBeyondViewport: false });
      if (!child.stdin.write(buf)) {
        await new Promise((resolve) => child.stdin.once("drain", resolve));
      }
      captured++;
      // تقدم حي على المهمة (10..95) + ملخص الـ workflow كل ~10%
      const pct = Math.round(10 + 85 * ((i + 1) / frames));
      if (pct >= lastPing + 10 || i === frames - 1) {
        lastPing = pct;
        void pingProgress(Math.min(95, pct)).catch(() => {});
        log(`التقدم: ${captured}/${frames} إطارًا (${pct}%)`);
      }
    }
    child.stdin.end();
    await closed;

    const st = fs.statSync(outputPath);
    if (st.size < 20_000) throw new Error(`الناتج صغير بشكل مريب (${st.size} بايت) — رندر فاشل غالبًا`);

    // التحقق النهائي بـ ffprobe: الأبعاد والمعدل والمدة ووجود مسار الصوت فعليًا
    const probe = await probeOutput(outputPath, { width, height, fps, duration, expectAudio: Boolean(audioPath) });
    await writeSummary(
      `**تحقق ffprobe**: ${probe.w}×${probe.h} @ ${probe.fps}fps — ${probe.durationSec.toFixed(2)}s — ` +
      (probe.hasAudio
        ? `مسار صوت ${probe.audioCodec}${audioPath ? " (التعليق مدمج)" : " (صامت مولّد — بلا تعليق صوتي مطلوب)"}`
        : "بلا مسار صوت"),
    );

    fs.copyFileSync(outputPath, PROGRESS_VIDEO_PATH);
    return { frames: captured, size: st.size, probe };
  } finally {
    try { await browser.close(); } catch { /* تجاهل */ }
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// ملء الكادر — اكتشاف مقاس المشهد الطبيعي وملاءمته للإطار الهدف

/**
 * المشاهد تُصمّم غالبًا بمقاس أصغر من FHD (720×1280 أو 540×960…) فتظهر صغيرة
 * بزاوية الإطار مع فراغ أسود. هنا نقيس المسرح الفعلي داخل الصفحة ثم نملأ الإطار
 * بأحد استراتيجيتين:
 *  1) viewport-dsf (الأفضل جودةً): إعادة ضبط العرض إلى مقاس التصميم مع
 *     deviceScaleFactor = الهدف/التصميم — المتصفح يرسم النص والمتجهات بدقة
 *     أعلى (ليس تكبيرًا نقطيًا). يُعتمد بعد تحقق فعلي من أبعاد لقطة PNG؛
 *  2) transform: تكبير CSS موحد للمسرح مع توسيط — اقتصاص مركزي عند تفاوت
 *     الأبعاد حتى 15%، أو حشو بخلفية المشهد عند تفاوت أكبر كي لا تظهر أشرطة سوداء.
 */
async function fitStageToFrame(page, targetW, targetH) {
  try {
    const natural = await page.evaluate(detectStageInPage);
    if (!natural || !(natural.w >= 160) || !(natural.h >= 160)) return null;
    // المشهد سائل بحجم الإطار بالفعل — لا شيء لفعله
    if (Math.abs(natural.w - targetW) <= 2 && Math.abs(natural.h - targetH) <= 2) return null;

    // المحاولة الأولى: deviceScaleFactor — أعلى جودة نص ومتجهات
    const nwR = Math.round(natural.w);
    const nhR = Math.round(natural.h);
    const dsf = targetW / nwR;
    if (dsf > 0.05 && dsf < 8) {
      await page.setViewport({ width: nwR, height: nhR, deviceScaleFactor: dsf });
      await page.evaluate(() => window.dispatchEvent(new Event("resize"))).catch(() => {});
      const probe = await page.screenshot({ type: "png", captureBeyondViewport: false });
      // puppeteer 23 يعيد Uint8Array بدل Buffer — DataView آمنة للاثنين
      const dv = new DataView(probe.buffer, probe.byteOffset, probe.byteLength);
      const pw = dv.getUint32(16); // IHDR width
      const ph = dv.getUint32(20); // IHDR height
      if (pw === targetW && ph === targetH) {
        return { naturalW: nwR, naturalH: nhR, strategy: "viewport-dsf", scale: dsf };
      }
      log(`تحقق dsf فشل (اللقطة ${pw}×${ph} بدل ${targetW}×${targetH}) — التحول إلى تكبير CSS`);
    }

    // الاستراتيجية الثانية: تكبير CSS موحد مع توسيط (اقتصاص ≤15% أو حشو)
    const applied = await page.evaluate(applyStageTransformInPage, { targetW, targetH });
    if (!applied || !(applied.scale > 0)) {
      await page.setViewport({ width: targetW, height: targetH, deviceScaleFactor: 1 });
      return null;
    }
    return {
      naturalW: Math.round(applied.naturalW),
      naturalH: Math.round(applied.naturalH),
      strategy: applied.mode === "cover" ? "transform-cover" : "transform-contain",
      scale: applied.scale,
    };
  } catch (e) {
    log(`ملء الكادر تخطى: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    try { await page.setViewport({ width: targetW, height: targetH, deviceScaleFactor: 1 }); } catch { /* تجاهل */ }
    return null;
  }
}

/** كشف المقاس الطبيعي للمشهد داخل الصفحة — يعمل داخل المتصفح ويوسم العناصر المرشحة */
function detectStageInPage() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const vArea = vw * vh;
  const nearly = (a, b) => Math.abs(a - b) <= 2;

  const marked = [];
  const consider = (el, w, h, priority) => {
    if (!el || !(w >= 160) || !(h >= 160)) return;
    if (nearly(w, vw) && nearly(h, vh)) return; // بحجم الإطار الحالي — مشهد سائل
    // عناصر صغيرة (شارة/شريط ترجمة) لا تمثل المسرح الكامل
    if (w * h < vArea * 0.12 || Math.min(w / vw, h / vh) < 0.3) return;
    marked.push({ el, w, h, priority, area: w * h });
  };

  // 1) عناصر الوسائط بأبعاد تصميمية صريحة — أعلى أولوية
  for (const el of document.querySelectorAll("svg, canvas, video")) {
    const r = el.getBoundingClientRect();
    consider(el, r.width || el.clientWidth, r.height || el.clientHeight, 1);
  }
  // 2) جسم/جذر بحجم تصميم ثابت (أقل من الإطار في البعدين)
  const body = document.body;
  const root = document.documentElement;
  if (body && body.offsetWidth < vw - 2 && body.offsetHeight < vh - 2) {
    consider(body, body.offsetWidth, body.offsetHeight, 2);
  }
  if (root && root.clientWidth < vw - 2 && root.clientHeight < vh - 2) {
    consider(root, root.clientWidth, root.clientHeight, 2);
  }
  // 3) حاويات مسرح شائعة
  const stageSel = "#stage,[data-stage],.stage,#scene,.scene,#app,#root,#container,#wrapper,.wrapper,main";
  for (const el of document.querySelectorAll(stageSel)) {
    if (el === body || el === root) continue;
    const r = el.getBoundingClientRect();
    consider(el, r.width, r.height, 3);
  }
  // 4) أبناء الجسم المباشرون — الابن الكبير الوحيد هو المسرح غالبًا، وإلا اتحادهم
  const kids = body
    ? Array.from(body.children).filter((c) => !["SCRIPT", "STYLE", "LINK", "NOSCRIPT"].includes(c.tagName))
    : [];
  const bigRects = kids.map((c) => c.getBoundingClientRect()).filter((r) => r.width >= 160 && r.height >= 160);
  if (bigRects.length === 1) {
    const theKid = kids.find((c) => { const r = c.getBoundingClientRect(); return r.width >= 160 && r.height >= 160; });
    consider(theKid, bigRects[0].width, bigRects[0].height, 4);
  } else if (bigRects.length > 1) {
    const u = bigRects.reduce((a, r) => ({
      left: Math.min(a.left, r.left), top: Math.min(a.top, r.top),
      right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom),
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    if (u.right > u.left && u.bottom > u.top) {
      // اتحاد عدة أبناء: يوسم كل عنصر كبير كي يُحوّل مجتمعين لاحقًا
      kids.forEach((c) => { const r = c.getBoundingClientRect(); if (r.width >= 160 && r.height >= 160) consider(c, r.width, r.height, 5); });
    }
  }

  if (!marked.length) return null;
  marked.sort((a, b) => (a.priority - b.priority) || (b.area - a.area));
  const best = marked[0];
  // وسوم على كل المرشحين — لا يمكن إعادة عناصر DOM من evaluate فتعاد قراءتها بالوسم
  for (const m of marked) m.el.setAttribute("data-meko-stage", String(m.priority));
  const r = best.el.getBoundingClientRect();
  return { w: best.w, h: best.h, left: r.left, top: r.top };
}

/** تطبيق التكبير CSS الموحد على العناصر الموسومة — يعمل داخل المتصفح */
function applyStageTransformInPage(spec) {
  const els = Array.from(document.querySelectorAll("[data-meko-stage]"));
  if (!els.length) return null;
  const targetW = spec.targetW;
  const targetH = spec.targetH;
  const rects = els.map((el) => ({ el, r: el.getBoundingClientRect() }));

  // اتحاد المسرح الموسوم — المرجع للتوسيط والاقتصاص المركزي
  const u = rects.reduce((a, x) => ({
    left: Math.min(a.left, x.r.left), top: Math.min(a.top, x.r.top),
    right: Math.max(a.right, x.r.right), bottom: Math.max(a.bottom, x.r.bottom),
  }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const nw = u.right - u.left;
  const nh = u.bottom - u.top;
  if (!(nw >= 160) || !(nh >= 160)) return null;

  const sx = targetW / nw;
  const sy = targetH / nh;
  const overflowRatio = 1 - Math.min(sx, sy) / Math.max(sx, sy);
  // توافق الأبعاد أو اقتصاص ≤15% → تغطية تامة؛ تفاوت كبير → حشو (حفاظ على المحتوى)
  const mode = overflowRatio <= 0.15 ? "cover" : "contain";
  const s = mode === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);
  const uLeft = (targetW - nw * s) / 2;
  const uTop = (targetH - nh * s) / 2;

  for (const { el, r } of rects) {
    // ترجمة + تكبير بمنشأ الزاوية العلوية اليسرى — يحفظ التخطيط النسبي لعناصر متعددة
    const dx = uLeft + s * (r.left - u.left) - r.left;
    const dy = uTop + s * (r.top - u.top) - r.top;
    el.style.transformOrigin = "0 0";
    el.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) scale(${s.toFixed(5)})`;
    el.removeAttribute("data-meko-stage");
  }

  // عند الحشو: خلفية الجذر من خلفية المسرح كي لا تبدو الأشرطة سوداء
  if (mode === "contain") {
    const bg = getComputedStyle(rects[0].el).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)") {
      document.documentElement.style.background = bg;
      if (document.body) document.body.style.background = bg;
    }
  }
  return { naturalW: nw, naturalH: nh, scale: s, mode, count: rects.length };
}

// ---------------------------------------------------------------------------
// المتصفح والخطوط

async function launchBrowser(width, height) {
  const puppeteer = require("puppeteer-core");
  const executablePath = await resolveChrome();
  log(`Chrome: ${executablePath}`);
  return puppeteer.launch({
    executablePath,
    headless: true,
    defaultViewport: { width, height, deviceScaleFactor: 1 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--font-render-hinting=none",
      "--disable-gpu-vsync",
      // تقليل الذاكرة في البيئات المحدودة — عملية عرض واحدة تكفي الالتقاط
      "--renderer-process-limit=1",
    ],
    protocolTimeout: 120_000,
  });
}

/** كروم النظام على ubuntu-latest (google-chrome-stable مثبت مسبقًا)، وإن غاب يُثبت Chrome for Testing */
async function resolveChrome() {
  const candidates = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const found = execFileSync("which", ["google-chrome-stable"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch { /* نكمل للتثبيت */ }
  log("كروم النظام غير موجود — تثبيت Chrome for Testing…");
  execFileSync("npx", ["-y", "@puppeteer/browsers", "install", "chrome@stable", "--path", "/tmp/chrome"], { stdio: "inherit", timeout: 240_000 });
  const root = "/tmp/chrome";
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (name === "chrome") return p;
    }
  }
  throw new Error("تعذر العثور على كروم بعد التثبيت");
}

/** حقن خطي Meko (Noto Sans Arabic + Liberation Sans) كـ @font-face — نفس سلوك محرك Vercel */
function injectFonts(html) {
  const fontsDir = path.join(__dirname, "..", "merger", "fonts");
  const families = { MekoArabic: "NotoSansArabic-Regular.ttf", MekoLatin: "LiberationSans-Regular.ttf" };
  const faces = [];
  const chain = [];
  for (const [family, file] of Object.entries(families)) {
    try {
      const bytes = fs.readFileSync(path.join(fontsDir, file));
      if (bytes.length > 1000) {
        faces.push(`@font-face{font-family:'${family}';src:url('data:font/ttf;base64,${bytes.toString("base64")}') format('truetype');font-weight:normal;font-style:normal;font-display:block;}`);
        chain.push(`'${family}'`);
      }
    } catch { /* الخط غائب — نكمل بخطوط النظام */ }
  }
  const fallback = chain.length ? `html,body{font-family:${chain.join(",")},system-ui,-apple-system,'Segoe UI',sans-serif;}` : "";
  if (!faces.length && !fallback) return html;
  const tag = `<style data-meko-fonts>${faces.join("")}${fallback}</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => `${m}${tag}`);
  return tag + html;
}

// ---------------------------------------------------------------------------
// FFmpeg والصوت

async function ensureFfmpeg() {
  const candidates = ["ffmpeg", "/usr/bin/ffmpeg"];
  for (const c of candidates) {
    try {
      execFileSync(c, ["-version"], { stdio: "ignore" });
      return c;
    } catch { /* التالي */ }
  }
  execFileSync("sudo", ["apt-get", "update"], { stdio: "inherit", timeout: 180_000 });
  execFileSync("sudo", ["apt-get", "install", "-y", "ffmpeg"], { stdio: "inherit", timeout: 300_000 });
  return "ffmpeg";
}

/** مدة الصوت من سطر Duration في مخرجات ffmpeg (بلا ffprobe) — دقيقة إلى سنتيسكند */
async function audioDurationSec(filePath) {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-i", filePath, "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => resolve(0));
    child.on("close", () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{2})/);
      if (m) resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100);
      else resolve(0);
    });
  });
}

// ---------------------------------------------------------------------------
// التحقق من الناتج — ffprobe على MP4 النهائي (الأبعاد/المعدل/المدة/مسار الصوت)

function ffprobeJson(file) {
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** بديل بلا ffprobe — تحليل تقرير ffmpeg عن المسارات والمدة */
function ffmpegInfoFallback(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-f", "null", "-"], { encoding: "utf8", timeout: 60_000 });
  const err = String((r && r.stderr) || "");
  const dur = err.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{2})/);
  const durationSec = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) + Number(dur[4]) / 100 : 0;
  const vid = /Stream #\d+:\d+.*?: Video: .*?(\d{2,5})x(\d{2,5})/.exec(err);
  const fpsM = /Stream #\d+:\d+.*?: Video: .*?([\d.]+) fps/.exec(err);
  const aud = /Stream #\d+:\d+.*?: Audio: (\w+)/.exec(err);
  return {
    video: vid ? { width: Number(vid[1]), height: Number(vid[2]), fpsText: fpsM ? fpsM[1] : "" } : null,
    audio: aud ? { codec_name: aud[1] } : null,
    durationSec,
  };
}

function parseFpsText(text) {
  if (!text) return 0;
  const m = String(text).match(/^(\d+)(?:\/(\d+))?$/);
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : Number(m[1]);
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

/**
 * تحقق صارم من الناتج النهائي قبل النشر — أي انحراف يعني رندرًا فاشلًا:
 * أبعاد الإطار = المطلوب، المعدل = المطلوب، المدة قريبة، ومسار الصوت موجود
 * عند وجود صوت مدمج (اختفاء الصوت بعد الرندر هو خطأ لا يُقبل).
 */
async function probeOutput(outputPath, expect) {
  const j = ffprobeJson(outputPath);
  let video = null;
  let audio = null;
  let durationSec = 0;
  if (j && Array.isArray(j.streams)) {
    video = j.streams.find((s) => s.codec_type === "video") || null;
    audio = j.streams.find((s) => s.codec_type === "audio") || null;
    durationSec = Number((j.format && j.format.duration) || 0) || Number((video && video.duration) || 0) || 0;
  } else {
    const fb = ffmpegInfoFallback(outputPath);
    video = fb.video;
    audio = fb.audio;
    durationSec = fb.durationSec;
  }
  if (!video) throw new Error("تحقق الناتج: لا يوجد مسار فيديو في MP4 النهائي!");

  const w = Number(video.width) || 0;
  const h = Number(video.height) || 0;
  const fps = parseFpsText(video.avg_frame_rate || video.r_frame_rate || video.fpsText || "");
  if (w !== expect.width || h !== expect.height) {
    throw new Error(`تحقق الناتج: الأبعاد ${w}×${h} بدل ${expect.width}×${expect.height} المطلوبة`);
  }
  if (fps && Math.abs(fps - expect.fps) > 0.6) {
    throw new Error(`تحقق الناتج: معدل الإطارات ${fps.toFixed(2)} بدل ${expect.fps} المطلوب`);
  }
  const durTol = Math.max(0.6, expect.duration * 0.05);
  if (durationSec && Math.abs(durationSec - expect.duration) > durTol) {
    throw new Error(`تحقق الناتج: المدة ${durationSec.toFixed(2)}s بدل ${expect.duration.toFixed(2)}s المطلوبة`);
  }
  if (expect.expectAudio && !audio) {
    throw new Error("تحقق الناتج: الصوت المدمج اختفى من MP4 النهائي — لا يوجد مسار صوت!");
  }
  return {
    w,
    h,
    fps: fps || expect.fps,
    durationSec: durationSec || expect.duration,
    hasAudio: Boolean(audio),
    audioCodec: (audio && audio.codec_name) || null,
  };
}

async function downloadAudio(url) {
  const str = String(url);

  // 1) صوت مضمّن data: (الحل الأخير للرفع في Meko عندما تفشل كل المضيفين) —
  //    يُفك محليًا بلا أي شبكة، فيصل الصوت دائمًا ولو حُجب كل المضيفين الخارجيين
  if (/^data:/i.test(str)) {
    const m = str.match(/^data:([\w.+/-]+)?;base64,([\s\S]+)$/i);
    if (!m) throw new Error("رابط الصوت المضمّن (data:) غير صالح — صيغة base64 مطلوبة");
    const buf = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
    if (buf.length < 512) throw new Error(`الصوت المضمّن (data:) أصغر من اللازم (${buf.length} بايت) — قد يكون فارغًا`);
    const dest = path.join(os.tmpdir(), `audio-${JOB_ID}.bin`);
    fs.writeFileSync(dest, buf);
    log(`الصوت المضمّن (data:${m[1] || "audio"}) — ${(buf.length / 1024).toFixed(0)}KB`);
    return dest;
  }

  // 2) رابط http — محاولتان مع ترويسة متصفح (مضيفون مثل catbox يرفضون ترويسة Node)
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchWithTimeout(str, { headers: { "User-Agent": UA, Accept: "*/*" } }, 120_000);
      if (!res.ok) throw new Error(`تعذر تنزيل الصوت (HTTP ${res.status}) من ${str.slice(0, 120)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 512) throw new Error("ملف الصوت غير صالح أو فارغ");
      const head = buf.subarray(0, 512).toString("latin1").trim().toLowerCase();
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (head.startsWith("<!doctype") || head.startsWith("<html") || ct.includes("text/html")) {
        throw new Error(`رابط الصوت يعيد صفحة HTML بدل الملف الخام (${ct || "بلا نوع"}) — انتهت صلاحية الرابط: ${str.slice(0, 120)}`);
      }
      const dest = path.join(os.tmpdir(), `audio-${JOB_ID}.bin`);
      fs.writeFileSync(dest, buf);
      return dest;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) {
        log(`تنزيل الصوت فشل (محاولة ${attempt}): ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)} — إعادة بعد 3 ثوانٍ…`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------
// النشر عبر meko-manger ثم الاحتياطات

async function publishToMerger(meta) {
  try {
    const buf = fs.readFileSync(PROGRESS_VIDEO_PATH);
    const chunks = Math.ceil(buf.length / CHUNK_BYTES);
    for (let i = 0; i < chunks; i++) {
      const part = buf.subarray(i * CHUNK_BYTES, Math.min((i + 1) * CHUNK_BYTES, buf.length));
      const res = await fetchWithTimeout(
        `${MERGER_BASE}/api/render-complete?op=chunk&task_id=${TASK_ID}&job_id=${JOB_ID}&chunk=${i}`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: part },
        60_000,
      );
      if (!res.ok) throw new Error(`فشل رفع الجزء ${i + 1}/${chunks} (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
      log(`رفع الجزء ${i + 1}/${chunks} — ${(part.length / 1048576).toFixed(2)}MB`);
    }
    const done = await finalizeToMerger(meta);
    if (!done) return null;
    // تحقق نهائي: صف المهمة done والفيديو يُخدم فعلًا (أول بايتات كافية للفحص)
    const jobRes = await fetchWithTimeout(`${MERGER_BASE}/api/jobs/${JOB_ID}`, {}, 30_000);
    const videoUrl = done.videoUrl.replace(/\?download=1$/, "");
    const videoRes = await fetchWithTimeout(videoUrl, { headers: { Range: "bytes=0-31" } }, 60_000);
    const contentType = videoRes.headers.get("content-type") || "";
    const videoOk = (videoRes.status === 200 || videoRes.status === 206) && contentType.includes("video");
    await videoRes.arrayBuffer().catch(() => undefined);
    if (!videoOk) throw new Error(`تحقق الفيديو فشل (HTTP ${videoRes.status}, content-type: ${contentType})`);
    log(`تحقق النشر: صف المهمة HTTP ${jobRes.status} — الفيديو HTTP ${videoRes.status} مع content-type video`);
    return done;
  } catch (e) {
    log(`فشل النشر عبر meko-manger: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** op=finalize — التحقق وإنشاء صف jobs وتحديث المهمة إلى completed/100 */
async function finalizeToMerger(meta) {
  const res = await fetchWithTimeout(
    `${MERGER_BASE}/api/render-complete?op=finalize&task_id=${TASK_ID}&job_id=${JOB_ID}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta) },
    60_000,
  );
  const text = await res.text();
  if (!res.ok) {
    log(`finalize فشل (HTTP ${res.status}): ${text.slice(0, 200)}`);
    return null;
  }
  const body = JSON.parse(text || "{}");
  // الخدمة تعيد snake_case (video_url) — نطبّعه إلى videoUrl للناشر
  if (!body.video_url) return null;
  return { ok: true, videoUrl: body.video_url, downloadUrl: body.download_url, host: body.host };
}

/** رفع الناتج إلى إصدار GitHub دائم (احتياط عند فشل meko-manger) */
async function uploadToRelease() {
  const token = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "");
  const repo = String(process.env.REPO_NAME || "");
  if (!token || !repo || !fs.existsSync(PROGRESS_VIDEO_PATH)) return null;
  try {
    const tag = `code-video-${JOB_ID.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}`;
    const api = (p, init) => fetchWithTimeout(`https://api.github.com${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", ...(init?.headers || {}) } }, 60_000);
    let rel = await api(`/repos/${repo}/releases/tags/${tag}`);
    if (!rel.ok) {
      rel = await api(`/repos/${repo}/releases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag_name: tag, name: `Code Video ${JOB_ID.slice(0, 8)}`, body: `ناتج الرندر الكامل للمهمة ${TASK_ID} (مهمة الدمج ${JOB_ID}) — رُفع كاحتياط بعد فشل الوصول إلى meko-manger.`, prerelease: true }),
      });
      if (!rel.ok) throw new Error(`فشل إنشاء الإصدار (HTTP ${rel.status})`);
    }
    const release = await rel.json();
    const assetBuf = fs.readFileSync(PROGRESS_VIDEO_PATH);
    const up = await fetchWithTimeout(
      `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=code-video-${JOB_ID.slice(0, 8)}.mp4`,
      { method: "POST", headers: { "Content-Type": "video/mp4", "Content-Length": String(assetBuf.length) }, body: assetBuf },
      300_000,
    );
    if (!up.ok) throw new Error(`فشل رفع الأصل (HTTP ${up.status})`);
    const asset = await up.json();
    log(`الأصل مرفوع للإصدار ${tag}`);
    return asset.browser_download_url;
  } catch (e) {
    log(`فشل رفع الإصدار: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** تحديث Turso مباشرة (آخر احتياط عند فشل meko-manger — يتطلب أسرار TURSO في الـ workflow) */
async function updateTaskDirectTurso({ videoUrl, width, height, fps, duration, frames }) {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) return false;
  try {
    const { createClient } = require("@libsql/client");
    let url = String(process.env.TURSO_DATABASE_URL);
    if (/^libsql:\/\//i.test(url)) url = "https://" + url.slice("libsql://".length);
    const db = createClient({ url: url.replace(/\/+$/, ""), authToken: String(process.env.TURSO_AUTH_TOKEN) });
    const r = await db.execute({ sql: `SELECT params_json FROM tasks WHERE id = ?`, args: [TASK_ID] });
    if (r.rows.length === 0) return false;
    let params = {};
    try { params = JSON.parse(String(r.rows[0].params_json || "{}")) || {}; } catch { params = {}; }
    params.videoUrl = videoUrl;
    params.videoDownloadUrl = videoUrl;
    params.videoDuration = duration;
    params.videoFps = fps;
    params.videoFrames = frames;
    params.videoJobId = JOB_ID;
    params.renderHost = "github-actions";
    await db.execute({
      sql: `UPDATE tasks SET status='completed', progress=100, result_urls_json=?, params_json=?, error_message=NULL, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`,
      args: [JSON.stringify([videoUrl]), JSON.stringify(params), TASK_ID],
    });
    return true;
  } catch (e) {
    log(`فشل تحديث Turso المباشر: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// تعليم الفشل والتقدم الحي

async function markFailed(message) {
  log(`تعليم المهمة فاشلة: ${message}`);
  try {
    const res = await fetchWithTimeout(
      `${MERGER_BASE}/api/render-complete?op=failed&task_id=${TASK_ID}&job_id=${JOB_ID}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: message }) },
      30_000,
    );
    if (res.ok) return true;
    log(`op=failed أعاد HTTP ${res.status}`);
  } catch (e) {
    log(`op=failed فشل: ${e instanceof Error ? e.message : String(e)}`);
  }
  const direct = await (async () => {
    if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) return false;
    try {
      const { createClient } = require("@libsql/client");
      let url = String(process.env.TURSO_DATABASE_URL);
      if (/^libsql:\/\//i.test(url)) url = "https://" + url.slice("libsql://".length);
      const db = createClient({ url: url.replace(/\/+$/, ""), authToken: String(process.env.TURSO_AUTH_TOKEN) });
      await db.execute({
        sql: `UPDATE tasks SET status='failed', error_message=?, updated_at=datetime('now') WHERE id=? AND status!='completed'`,
        args: [message.slice(0, 490), TASK_ID],
      });
      return true;
    } catch (e) {
      log(`تحديث Turso المباشر فشل: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  })();
  return direct;
}

async function pingProgress(p) {
  try {
    await fetchWithTimeout(`${MERGER_BASE}/api/render-complete?op=progress&task_id=${TASK_ID}&job_id=${JOB_ID}&p=${p}`, { method: "POST" }, 20_000);
  } catch { /* التقدم حي ليس حرجًا */ }
}

async function writeSummary(line) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) {
    try { fs.appendFileSync(f, `${line}\n`); } catch { /* تجاهل */ }
  }
}

// ---------------------------------------------------------------------------
// أدوات عامة

function clampEven(v, min, max) {
  let n = Math.round(Number(v) || min);
  n = Math.max(min, Math.min(max, n));
  return n % 2 === 0 ? n : n + 1;
}

function sanitizeTimings(raw) {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const list = raw.slice(0, MAX_WORD_TIMINGS).map((w) => {
    const o = w && typeof w === "object" ? w : {};
    const start = Number(o.start);
    const end = Number(o.end);
    const text = typeof o.text === "string" ? o.text.slice(0, 200) : "";
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !text) return null;
    return { start: Math.max(0, start), end: Math.max(0, end), text };
  }).filter(Boolean);
  if (list.length < 2) return null;
  list.sort((a, b) => a.start - b.start);
  return list;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
