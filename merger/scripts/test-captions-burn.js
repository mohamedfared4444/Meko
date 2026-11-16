/**
 * اختبار حرق الترجمة عبر مسار الكود الحقيقي (prepareCaptions + buildSubtitleFilter).
 *   node scripts/test-captions-burn.js
 * ينتج فيديوهين:
 *   /tmp/cap-test/out-fixed.mp4   — المسار المُصلح: fontsdir + الخط المضمّن
 *   /tmp/cap-test/out-fallback.mp4 — محاكاة فشل إيجاد الخط (خط ساقط بلا تشكيل)
 * ثم يستخرج إطارات للفحص البصري. بار سودوي أسفل الإطار لمحاكاة شريط التشغيل
 * والتحقق من MarginV=90 بكسل حقيقي.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { prepareCaptions, buildSubtitleFilter, writeFontConfig } = require("../lib/videocut");

const ffmpeg = require("ffmpeg-static");
const OUT = "/tmp/cap-test";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ترجمة اختبار: مثال المستخدم + سطر مختلط + سطر بترقيم وعلامات
const srt = [
  "1", "00:00:00,300 --> 00:00:03,200", "مكتبة الإسكندرية القديمة", "",
  "2", "00:00:03,300 --> 00:00:06,200", "نص عربي مع English 2025", "",
  "3", "00:00:06,300 --> 00:00:09,900", "في عام 2025 قرأت 3 كتب مثيرة.", "",
].join("\r\n");
const capUrl = "data:text/plain;base64," + Buffer.from(srt, "utf8").toString("base64");

async function main() {
  const spec = { captions_url: capUrl, captions: true, aspect_ratio: "9:16" };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "captest-"));
  const fontCfg = writeFontConfig(tmpDir);
  const captions = await prepareCaptions(spec, tmpDir);
  if (!captions.path) throw new Error("prepareCaptions فشل: " + captions.warning);

  const shapedSrt = fs.readFileSync(captions.path, "utf8");
  fs.writeFileSync(path.join(OUT, "captions-shaped.srt"), shapedSrt);
  console.log("=== ملف SRT بعد التحضير (كما يراه FFmpeg) ===");
  console.log(shapedSrt.split("\r\n").map((l) => l.trim()).filter(Boolean).slice(2, 3)[0]);
  console.log("preshaped:", captions.preshaped);

  const commonArgs = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=cornflowerblue:size=720x1280:rate=30:duration=10",
    "-vf", "drawbox=x=0:y=1250:w=720:h=30:color=black@0.85:t=fill," +
      buildSubtitleFilter(captions.path, { fontDir: fontCfg.fontDir, isPortrait: true, height: 1280 }),
    "-c:v", "libx264", "-crf", "22", "-preset", "veryfast", "-r", "30", "-t", "10",
  ];

  // 1) المسار المُصلح — fontsdir + FONTCONFIG_FILE
  execFileSync(ffmpeg, [...commonArgs, path.join(OUT, "out-fixed.mp4")],
    { env: { ...process.env, FONTCONFIG_FILE: fontCfg.confPath }, stdio: "inherit" });

  // 2) محاكاة فشل الخط: بلا fontsdir وبلا FONTCONFIG_FILE — يقع libass على خط النظام
  const degradedFilter = buildSubtitleFilter(captions.path, { fontDir: null, isPortrait: true, height: 1280 })
    .replace(":fontsdir='[^']*'", "");
  const argsDegraded = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=cornflowerblue:size=720x1280:rate=30:duration=10",
    "-vf", "drawbox=x=0:y=1250:w=720:h=30:color=black@0.85:t=fill," + degradedFilter,
    "-c:v", "libx264", "-crf", "22", "-preset", "veryfast", "-r", "30", "-t", "10",
    path.join(OUT, "out-fallback.mp4"),
  ];
  execFileSync(ffmpeg, argsDegraded, { env: { ...process.env, FONTCONFIG_FILE: undefined }, stdio: "inherit" });

  // استخراج إطارات الفحص (سطر عربي / مختلط / أرقام)
  for (const [t, name] of [[1.5, "fixed-arabic"], [4.5, "fixed-mixed"], [7.5, "fixed-nums"]]) {
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-ss", String(t), "-i", path.join(OUT, "out-fixed.mp4"), "-frames:v", "1", "-update", "1", path.join(OUT, `frame-${name}.png`)]);
  }
  for (const [t, name] of [[1.5, "fallback-arabic"], [4.5, "fallback-mixed"]]) {
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-ss", String(t), "-i", path.join(OUT, "out-fallback.mp4"), "-frames:v", "1", "-update", "1", path.join(OUT, `frame-${name}.png`)]);
  }
  console.log("DONE — الملفات في", OUT);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
