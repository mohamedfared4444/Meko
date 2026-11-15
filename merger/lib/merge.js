/**
 * محرك الدمج — ffmpeg + ffprobe داخل الدالة نفسها.
 * - توحيد كل المصادر عبر filter_complex: scale + pad إلى أكبر دقة بين المدخلات
 *   (حد أقصى 1920×1080، أبعاد زوجية)، fps=30، setsar=1، format=yuv420p،
 *   ثم concat=n=:v=1:a=1.
 * - مصدر بلا صوت؟ يُضاف مسار صامت anullsrc بنفس مدته بدل أن يفشل الدمج.
 * - الترميز النهائي: libx264 CRF 18 + AAC 192k/44100Hz + +faststart — MP4 عالي
 *   الجودة يعمل فورًا على الويب. الـ preset من متغير البيئة.
 * - تقدم الترميز: قراءة out_time_us من -progress pipe:1 وحساب النسبة (40–90).
 * - ثنائي ffmpeg قد يفقد صلاحية التنفيذ في الاستضافة: ensureExecutable
 *   ينسخه إلى /tmp بصلاحية 755 عند الحاجة.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const { LIMITS, getJob, updateJob, saveBlobRows, deleteJobCascade, getDb } = require("./db");

// ---------------------------------------------------------------------------
// تجهيز الثنائيات

async function ensureExecutable(binPath) {
  // على Vercel نظام الملفات للقراءة فقط وربما فقد التنفيذ صلاحيته — ننسخه إلى /tmp
  try {
    await fs.promises.access(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    const tmp = path.join(os.tmpdir(), `bin-${path.basename(binPath)}-${process.pid}`);
    await fs.promises.copyFile(binPath, tmp);
    await fs.promises.chmod(tmp, 0o755);
    return tmp;
  }
}

async function ffmpegBin() {
  return ensureExecutable(ffmpegStatic);
}

async function ffprobeBin() {
  return ensureExecutable(ffprobeStatic.path);
}

// ---------------------------------------------------------------------------
// تشغيل الأوامر

function run(cmd, args, { onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    child.stdout.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      if (onStdoutLine) {
        lineBuf += text;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() || "";
        for (const l of lines) onStdoutLine(l.trim());
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`(${path.basename(cmd)}) خرج بكود ${code}: ${stderr.slice(-800)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// ffprobe — الدقة، معدل الإطارات، المدة، وجود صوت

async function probeFile(filePath) {
  const bin = await ffprobeBin();
  let stdout = "";
  try {
    ({ stdout } = await run(bin, [
      "-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath,
    ]));
  } catch (e) {
    throw new Error("الملف ليس فيديو صالحًا أو تالفًا (" + String(e.message).slice(0, 160) + ")");
  }
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error("تعذر تحليل بيانات الملف بـ ffprobe");
  }
  const video = (info.streams || []).find((s) => s.codec_type === "video");
  const audio = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!video) throw new Error("الملف لا يحتوي مسار فيديو صالح");
  const duration = Number(info.format?.duration || video.duration || 0);
  return {
    width: Number(video.width),
    height: Number(video.height),
    fps: Number(video.r_frame_rate ? evalFps(video.r_frame_rate) : 30),
    duration: Number.isFinite(duration) ? duration : 0,
    hasAudio: !!audio,
  };
}

function evalFps(r) {
  const [a, b] = String(r).split("/").map(Number);
  if (!b) return a || 30;
  return a / b;
}

// ---------------------------------------------------------------------------
// جمع المصادر إلى /tmp

async function downloadSource(url, destPath, maxBytes) {
  // نستخدم curl عبر spawn لتفادي حدود fetch على ملفات كبيرة وللتحكم بالحجم.
  // -f: فشل صريح عند أي خطأ HTTP (مثل 403) بدل حفظ صفحة الخطأ كملف.
  await new Promise((resolve, reject) => {
    const child = spawn("curl", ["-fsSL", "--max-time", "240", "-o", destPath, url]);
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`تعذر تنزيل المصدر (${url}): ${err.trim().slice(-200) || "HTTP error"}`))));
  });
  const st = await fs.promises.stat(destPath);
  if (st.size > maxBytes) {
    throw new Error(`حجم المصدر (${(st.size / 1048576).toFixed(1)}MB) يتجاوز الحد ${(maxBytes / 1048576).toFixed(0)}MB`);
  }
  if (st.size < 1024) {
    throw new Error(`المصدر غير صالح أو محمي من التنزيل (${url}) — الحجم ${st.size} بايت فقط`);
  }
  return st.size;
}

async function reassembleUploadedSource(jobId, seq, destPath) {
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT data FROM source_chunks WHERE job_id = ? AND source_seq = ? ORDER BY chunk_seq`,
    args: [jobId, seq],
  });
  const out = fs.createWriteStream(destPath);
  for (const row of r.rows) {
    const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    await new Promise((res, rej) => {
      out.write(buf, (e) => (e ? rej(e) : res()));
    });
  }
  await new Promise((res) => out.end(res));
  const st = await fs.promises.stat(destPath);
  if (st.size === 0) throw new Error("المصدر المرفوع فارغ — أكمل رفع الأجزاء أولًا");
  return st.size;
}

// ---------------------------------------------------------------------------
// دمج مهمة كاملة — تنفَّذ داخل POST /api/jobs/{id}/process (متزامن)

async function runMergeJob(jobId, publicBase) {
  const job = await getJob(jobId);
  if (!job) throw new Error("المهمة غير موجودة");
  if (job.status === "processing") return { status: 202 };
  if (job.status === "done") return { status: 200, job };
  if (job.status === "failed") return { status: 409, job };

  const sources = job.sources || [];
  const limits = {
    sourceMax: LIMITS.SOURCE_MAX_MB() * 1048576,
    outputMax: LIMITS.OUTPUT_MAX_MB() * 1048576,
    maxTotalDuration: LIMITS.MAX_TOTAL_DURATION_SEC(),
  };

  if (sources.length < 2) {
    await updateJob(jobId, { status: "failed", error: "الدمج يحتاج مقطعين على الأقل" });
    return { status: 400, error: "الدمج يحتاج مقطعين على الأقل" };
  }
  if (sources.length > LIMITS.MAX_SOURCES()) {
    await updateJob(jobId, { status: "failed", error: `أقصى عدد مصادر هو ${LIMITS.MAX_SOURCES()}` });
    return { status: 400, error: `أقصى عدد مصادر هو ${LIMITS.MAX_SOURCES()}` };
  }

  await updateJob(jobId, { status: "processing", progress: 2, error: null });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `merge-${jobId}-`));
  const outputPath = path.join(tmpDir, "output.mp4");
  try {
    // 1) جمع المصادر (0–40%)
    const paths = [];
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const dest = path.join(tmpDir, `src-${i}.bin`);
      if (src.kind === "url") {
        await downloadSource(src.url, dest, limits.sourceMax);
      } else {
        const size = await reassembleUploadedSource(jobId, i, dest);
        if (size > limits.sourceMax) {
          throw new Error(`حجم المصدر المرفوع يتجاوز الحد ${(limits.sourceMax / 1048576).toFixed(0)}MB`);
        }
      }
      paths.push(dest);
      await updateJob(jobId, { progress: Math.round(5 + (35 * (i + 1)) / sources.length) });
    }

    // 2) فحص كل مصدر بـ ffprobe + التحقق من حدود المدة
    const infos = [];
    let totalDuration = 0;
    for (const p of paths) {
      const info = await probeFile(p);
      if (info.duration <= 0) throw new Error("تعذر تحديد مدة أحد المصادر");
      totalDuration += info.duration;
      if (totalDuration > limits.maxTotalDuration) {
        throw new Error(`مجموع مدد المقاطع (${Math.round(totalDuration)}s) يتجاوز الحد ${limits.maxTotalDuration} ثانية`);
      }
      infos.push(info);
    }

    // 3) حساب الأبعاد الهدف — أكبر دقة بين المدخلات مع حد 1920×1080 وأبعاد زوجية
    let W = Math.max(...infos.map((i) => i.width));
    let H = Math.max(...infos.map((i) => i.height));
    W = Math.min(W, 1920);
    H = Math.min(H, 1080);
    W -= W % 2;
    H -= H % 2;

    // 4) بناء أمر ffmpeg — مدخلات + anullsrc للمصادر الصامتة + filter_complex
    // ملاحظة حرجة: فهرس المدخل ≠ فهرس المصدر — المصادر الصامتة تضيف مدخلات
    // lavfi إضافية تُزيح كل الفهارس التالية.
    const ffmpeg = await ffmpegBin();
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    const videoInputFor = []; // لكل مصدر: مؤشر مدخل الفيديو
    const audioInputFor = []; // لكل مصدر: مؤشر مدخل الصوت

    let nextInput = 0;
    for (let i = 0; i < paths.length; i++) {
      args.push("-i", paths[i]);
      videoInputFor[i] = nextInput++;
      if (infos[i].hasAudio) {
        audioInputFor[i] = videoInputFor[i]; // نفس المدخل يحمل مسار الصوت
      } else {
        // مسار صامت بنفس مدة المصدر بدل أن يفشل الدمج
        args.push("-f", "lavfi", "-t", infos[i].duration.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
        audioInputFor[i] = nextInput++;
      }
    }

    const filters = [];
    for (let i = 0; i < paths.length; i++) {
      filters.push(
        `[${videoInputFor[i]}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`,
      );
      filters.push(`[${audioInputFor[i]}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
    const concatMaps = infos.map((_, i) => `[v${i}][a${i}]`).join("");
    filters.push(`${concatMaps}concat=n=${paths.length}:v=1:a=1[vout][aout]`);

    args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]");
    args.push("-c:v", "libx264", "-crf", "18", "-preset", LIMITS.FFMPEG_PRESET());
    args.push("-c:a", "aac", "-b:a", "192k", "-ar", "44100");
    args.push("-movflags", "+faststart", outputPath);

    // 5) الترميز مع قراءة التقدم (40–90%)
    const totalOutDuration = totalDuration;
    const startedAt = Date.now();
    await run(ffmpeg, args, {
      onStdoutLine: (line) => {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m) {
          const seconds = Number(m[1]) / 1e6;
          const ratio = Math.max(0, Math.min(1, seconds / totalOutDuration));
          const pct = Math.round(40 + ratio * 50);
          void updateJob(jobId, { progress: pct });
        }
      },
    });

    // 6) التحقق من حجم الناتج وتخزينه (90–100%)
    const st = await fs.promises.stat(outputPath);
    if (st.size > limits.outputMax) {
      throw new Error(`حجم الناتج (${(st.size / 1048576).toFixed(1)}MB) يتجاوز الحد ${(limits.outputMax / 1048576).toFixed(0)}MB`);
    }

    await updateJob(jobId, { progress: 92 });
    const blob = await fs.promises.readFile(outputPath);
    await saveBlobRows("output_chunks", ["job_id"], [jobId], blob);

    // بعد نجاح الدمج احذف source_chunks — الناتج فقط هو المطلوب
    await getDb().execute({ sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [jobId] });

    const videoUrl = `${publicBase}/api/jobs/${jobId}/video`;
    const downloadUrl = `${publicBase}/api/jobs/${jobId}/video?download=1`;
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
    await updateJob(jobId, {
      status: "done",
      progress: 100,
      video_url: videoUrl,
      download_url: downloadUrl,
      size: st.size,
      duration: Number(totalOutDuration.toFixed(2)),
      resolution: `${W}x${H}`,
      expires_at: expiresAt,
      error: null,
    });

    return {
      status: 200,
      job: await getJob(jobId),
      meta: { encodedInSec: ((Date.now() - startedAt) / 1000).toFixed(1) },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateJob(jobId, { status: "failed", error: msg });
    return { status: 500, error: msg };
  } finally {
    // تنظيف /tmp دائمًا — لا ملفات دائمة
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { runMergeJob, probeFile, ensureExecutable, ffmpegBin, ffprobeBin };
