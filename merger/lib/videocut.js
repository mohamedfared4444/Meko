/**
 * محرك تحريك الصور — images_to_video عبر ffmpeg داخل الدالة نفسها.
 *
 * يستقبل مصفوفة روابط صور + صوت اختياري ويخرج فيديو MP4 سينمائيًا:
 *  - حركة كاميرا ناعمة لكل صورة (Ken Burns): تدوير تلقائي بين
 *    zoom-in / zoom-out / pan-right / pan-left (تفصيل زمني سلس، بلا قفزات).
 *  - انتقالات Crossfade سلسة بين المشاهد (xfade، المدة افتراضيًا 0.6 ثانية).
 *  - مدة عرض كل صورة تُحسب تلقائيًا لتطابق إجمالي مدة الصوت تمامًا:
 *      sum(d_i) = audioDur + (n-1)*T  →  d_i = (audioDur + (n-1)*T) / n
 *  - بلا صوت؟ مدة قياسية لكل صورة (3.5 ثانية) أو total_duration من الطلب.
 *  - دقة الهدف من aspect_ratio: 9:16 → 720×1280 (Shorts/Reels)،
 *    16:9 → 1280×720 (يوتيوب)؛ 1080p اختياري (1080×1920 / 1920×1080).
 *  - ترميز libx264 CRF 21 + preset veryfast (قابل للتجاوز بـ VIDEOCUT_PRESET)
 *    + AAC 192k/44100Hz + faststart — MP4 يعمل فورًا على الويب.
 *  - الناتج يُخزَّن في output_chunks ويُخدم عبر /api/jobs/{id}/video
 *    (نفس آلية مهام الدمج) — فتكون الروابط بنفس الصيغة المعتمدة.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { LIMITS, updateJob, saveBlobRows } = require("./db");
const { ensureExecutable, ffmpegBin, ffprobeBin } = require("./merge");

const MAX_IMAGES = 20;
const TRANSITION_DEFAULT = 0.6;
const PER_IMAGE_DEFAULT = 3.5; // بلا صوت — مدة كل صورة بالثواني
const FFMPEG_FPS = 30;

// ---------------------------------------------------------------------------
// تشغيل الأوامر

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`(ffmpeg/ffprobe) خرج بكود ${code}: ${stderr.slice(-600)}`));
    });
  });
}

async function ensureBinary(binPath) {
  return ensureExecutable(binPath);
}

/** أنواع MIME المعروفة للمصادر — يُستخدم لرفض صفحات HTML المزيفة */
const IMAGE_MAGICS = [
  { m: Buffer.from([0xff, 0xd8, 0xff]), label: "jpeg" },
  { m: Buffer.from([0x89, 0x50, 0x4e, 0x47]), label: "png" },
  { m: Buffer.from("GIF8"), label: "gif" },
  { m: Buffer.from("RIFF"), label: "webp/gif" },
  { m: Buffer.from("BM"), label: "bmp" },
];

/** تنزيل ملف إلى مسار — fetch مع حد حجم صريح وفحص محتوى.
 *  kind اختياري: "image" يفرض أن المحتوى صورة حقيقية (magic bytes)،
 *  و"audio" يفرض صوتًا — بعض مضيفي الرفع يعيدون صفحة HTML عند تغيّر
 *  سلوكهم أو انتهاء صلاحية الرابط الموقّع، وحفظها كملف يفشل ffmpeg
 *  لاحقًا برسالة غامضة («Could not open encoder») فنرفضها هنا فورًا
 *  برسالة عربية واضحة تسمح بالتشخيص الفوري. */
async function downloadTo(url, destPath, maxBytes, kind) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`تعذر تنزيل المورد (${res.status}): ${url.slice(0, 120)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(`حجم المورد (${(buf.length / 1048576).toFixed(1)}MB) يتجاوز الحد ${(maxBytes / 1048576).toFixed(0)}MB`);
  }
  if (buf.length < 128) {
    throw new Error(`المورد غير صالح أو فارغ (${url.slice(0, 120)})`);
  }
  const head = buf.subarray(0, 512).toString("latin1").trim().toLowerCase();
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const looksHtml = head.startsWith("<!doctype") || head.startsWith("<html") || ct.includes("text/html");
  if (looksHtml) {
    throw new Error(`الرابط يعيد صفحة HTML بدل الملف الخام (content-type: ${ct || "بلا نوع"}) — انتهت صلاحية الرابط الموقّع أو غيّر المضيف سلوكه: ${url.slice(0, 120)}`);
  }
  if (kind === "image" && !IMAGE_MAGICS.some((x) => buf.subarray(0, x.m.length).equals(x.m))) {
    throw new Error(`المحتوى المستلم ليس صورة معروفة (content-type: ${ct || "بلا نوع"}) من ${url.slice(0, 120)}`);
  }
  await fs.promises.writeFile(destPath, buf);
  return buf.length;
}

/** مدة ملف صوت بالثواني عبر ffprobe */
async function audioDurationSec(binPath, filePath) {
  try {
    const { stdout } = await run(binPath, [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath,
    ]);
    const d = Number(stdout.trim().split("\n")[0]);
    if (Number.isFinite(d) && d > 0.05) return d;
  } catch {
    /* نقع في التقدير */
  }
  // تقدير احتياطي: حجم البايتات / 6KBps (صوت 48kbit)
  const st = await fs.promises.stat(filePath);
  return Math.max(1, (st.size * 8) / 48_000);
}

// ---------------------------------------------------------------------------
// بناء فلاتر Ken Burns

/** تعبيرات zoompan لكل تأثير — D عدد إطارات المشهد */
function kenBurnsExpr(effect, D) {
  switch (effect) {
    case "zoom-in":
      return { z: `min(1+${(0.18).toFixed(3)}*on/${D},1.18)`, x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" };
    case "zoom-out":
      return { z: `max(1.18-${(0.18).toFixed(3)}*on/${D},1.0)`, x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" };
    case "pan-right":
      return { z: "1.12", x: `(iw-iw/zoom)*on/${D}`, y: "(ih-ih/zoom)/2" };
    case "pan-left":
      return { z: "1.12", x: `(iw-iw/zoom)*(1-on/${D})`, y: "(ih-ih/zoom)/2" };
    default:
      return { z: "1.05", x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" };
  }
}

// ---------------------------------------------------------------------------
// تنفيذ مهمة videocut بالكامل — متزامنة داخل الطلب

async function runVideocutJob(jobId, spec) {
  const images = spec.images || [];
  const T = Number(spec.transition) > 0 && Number(spec.transition) <= 2 ? Number(spec.transition) : TRANSITION_DEFAULT;
  const isPortrait = spec.aspect_ratio !== "16:9"; // الافتراضي 9:16
  const hiRes = spec.resolution === "1080p";
  const W = (isPortrait ? 720 : 1280) * (hiRes ? 1.5 : 1);
  const H = (isPortrait ? 1280 : 720) * (hiRes ? 1.5 : 1);
  const w = Math.round(W / 2) * 2;
  const h = Math.round(H / 2) * 2;
  const fps = FFMPEG_FPS;
  const preset = process.env.VIDEOCUT_PRESET || "veryfast";

  await updateJob(jobId, { status: "processing", progress: 2, error: null });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `vcut-${jobId}-`));
  const outputPath = path.join(tmpDir, "output.mp4");
  try {
    // 1) تنزيل الصور (2–20%) — تحقق من كل رابط قبل أي encode
    const imgPaths = [];
    for (let i = 0; i < images.length; i++) {
      const dest = path.join(tmpDir, `img-${i}.img`);
      // data: URLs تُكتب مباشرة (حل السقوط الأخير في سلسلة الرفع)
      if (/^data:image\//i.test(images[i])) {
        const b64 = images[i].slice(images[i].indexOf(",") + 1);
        const buf = Buffer.from(b64, "base64");
        if (buf.length < 128) throw new Error(`صورة data: تالفة عند الفهرس ${i}`);
        await fs.promises.writeFile(dest, buf);
      } else {
        await downloadTo(images[i], dest, 15 * 1048576, "image");
      }
      imgPaths.push(dest);
      await updateJob(jobId, { progress: Math.round(2 + (18 * (i + 1)) / images.length) });
    }

    // 2) الصوت (22%) ومدته الدقيقة
    let audioPath = null;
    let audioDur = 0;
    if (spec.audio_url && /^https?:\/\/.+/i.test(String(spec.audio_url))) {
      audioPath = path.join(tmpDir, "audio.bin");
      await downloadTo(spec.audio_url, audioPath, 40 * 1048576, "audio");
      const probe = await ensureBinary(require("ffprobe-static").path);
      audioDur = await audioDurationSec(probe, audioPath);
    } else if (/^data:audio\//i.test(String(spec.audio_url || ""))) {
      audioPath = path.join(tmpDir, "audio.bin");
      const b64 = spec.audio_url.slice(spec.audio_url.indexOf(",") + 1);
      const buf = Buffer.from(b64, "base64");
      if (buf.length < 128) throw new Error("ملف صوت data: تالف");
      await fs.promises.writeFile(audioPath, buf);
      const probe = await ensureBinary(require("ffprobe-static").path);
      audioDur = await audioDurationSec(probe, audioPath);
    }

    const n = imgPaths.length;
    const targetTotal = audioDur > 0 ? audioDur : Math.max(1, Number(spec.total_duration) || PER_IMAGE_DEFAULT * n);
    // مدة كل مشهد بحيث مجموع الفيديو بعد الانتقالات يساوي هدفنا:
    //   sum(scene_len) = targetTotal + (n-1)*T  →  d = (targetTotal + (n-1)*T)/n
    // ملاحظة حرجة: طول المشهد الفعلي = frames/fps وليس d نفسها — نستخدم ceil
    // (تدوير لأعلى) حتى لا يقل الطول الفعلي عن المطلوب أبدًا، وإلا أصبح
    // offset في xfade أكبر من طول المقطع الأول فيفشل ffmpeg بـ Invalid argument.
    // الإزاحات والمدة النهائية تُحسب من الأطوال الفعلية ثم تُقفَّل بـ -t على المدة المطلوبة.
    const d = (targetTotal + (n - 1) * T) / n;
    const framesPerScene = Math.max(2, Math.ceil(d * fps));
    const sceneLen = framesPerScene / fps; // الطول الفعلي لكل مشهد

    // حدود قصوى أمان: دقة/مدة الترميز مقابل حد الدالة 60 ثانية
    const totalPlanned = targetTotal;
    if (totalPlanned > 300) {
      throw new Error(`المدة المطلوبة (${Math.round(totalPlanned)} ثانية) تتجاوز الحد 300 ثانية`);
    }

    await updateJob(jobId, { progress: 24 });

    // 3) بناء أمر ffmpeg (26–40%)
    const ffmpeg = await ffmpegBin();
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats"];

    for (const p of imgPaths) args.push("-i", p); // مدخلات الصور 0..n-1
    let audioInput = -1;
    if (audioPath) {
      args.push("-i", audioPath); // مدخل الصوت n
      audioInput = n;
    } else {
      args.push("-f", "lavfi", "-t", totalPlanned.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
      audioInput = n;
    }

    const filters = [];
    // Ken Burns لكل صورة: تكبير مسبق 2x لتفادي اهتزاز zoompan ثم تصغير للمقاس النهائي
    for (let i = 0; i < n; i++) {
      const effect = ["zoom-in", "pan-right", "zoom-out", "pan-left"][i % 4];
      const kb = kenBurnsExpr(effect, framesPerScene);
      filters.push(
        `[${i}:v]scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},setsar=1,` +
          `zoompan=z='${kb.z}':x='${kb.x}':y='${kb.y}':d=${framesPerScene}:s=${w}x${h}:fps=${fps},` +
          `format=yuv420p,trim=duration=${sceneLen.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps},settb=AVTB[v${i}]`,
      // fps+settb إجباريان قبل xfade — مخرجات zoompan تحمل معدل إطارات غير محدد (1/0) فيرفض xfade
      );
    }
    // سلسلة انتقالات Crossfade — الإزاحات تُحسب تراكميًا
    if (n === 1) {
      filters.push(`[v0]copy[vout]`);
    } else {
      let prev = "v0";
      let consumed = 0; // مجموع الأطوال الفعلية للمقاطع المستهلكة حتى الآن
      for (let i = 1; i < n; i++) {
        consumed += sceneLen;
        const offset = consumed - T;
        const label = `x${i}`;
        filters.push(`[${prev}][v${i}]xfade=transition=fade:duration=${T.toFixed(3)}:offset=${offset.toFixed(3)}[${label}]`);
        prev = label;
      }
      filters.push(`[${prev}]format=yuv420p[vout]`);
    }
    // الصوت
    filters.push(
      audioPath
        ? `[${audioInput}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad[aout]`
        : `[${audioInput}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`,
    );

    args.push("-filter_complex", filters.join(";"));
    args.push("-map", "[vout]", "-map", "[aout]");
    args.push("-t", totalPlanned.toFixed(3)); // تقفيل دقيق على مدة الصوت
    args.push("-c:v", "libx264", "-crf", "21", "-preset", preset, "-r", String(fps));
    args.push("-c:a", "aac", "-b:a", "192k", "-ar", "44100");
    args.push("-movflags", "+faststart");
    args.push(outputPath);

    await updateJob(jobId, { progress: 30 });

    // 4) الترميز مع قراءة التقدم (30–92%)
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      let lineBuf = "";
      child.stdout.on("data", (dt) => {
        lineBuf += dt.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() || "";
        for (const l of lines) {
          const m = l.trim().match(/^out_time_us=(\d+)/);
          if (m) {
            const sec = Number(m[1]) / 1e6;
            const pct = Math.round(30 + Math.max(0, Math.min(1, sec / totalPlanned)) * 62);
            void updateJob(jobId, { progress: pct }).catch(() => {});
          }
        }
      });
      child.stderr.on("data", (dt) => {
        stderr += dt.toString();
        if (stderr.length > 20000) stderr = stderr.slice(-20000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`(ffmpeg) خرج بكود ${code}: ${stderr.slice(-600)}`));
      });
    });

    // 5) التحقق من الناتج وتخزينه (92–100%)
    const st = await fs.promises.stat(outputPath);
    if (st.size > LIMITS.OUTPUT_MAX_MB() * 1048576) {
      throw new Error(`حجم الناتج (${(st.size / 1048576).toFixed(1)}MB) يتجاوز الحد`);
    }
    await updateJob(jobId, { progress: 93 });
    const blob = await fs.promises.readFile(outputPath);
    await saveBlobRows("output_chunks", ["job_id"], [jobId], blob);

    // publicBase يُمرَّر من الطلب — بناء روابط النتيجة بنفس صيغة مهام الدمج
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
      duration: Number(totalPlanned.toFixed(2)),
      resolution: `${w}x${h}`,
      expires_at: expiresAt,
      error: null,
    });

    return {
      httpStatus: 200,
      jobId,
      status: "done",
      video_url: videoUrl,
      download_url: downloadUrl,
      duration: Number(totalPlanned.toFixed(2)),
      resolution: `${w}x${h}`,
      size: st.size,
      scenes: n,
      transition: T,
      had_audio: !!audioPath,
      expiresAt,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateJob(jobId, { status: "failed", error: msg.slice(0, 500) }).catch(() => {});
    return { httpStatus: 500, status: "failed", error: msg.slice(0, 800) };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}


module.exports = { runVideocutJob };
