/**
 * اختبار وحدات لمحرك الدمج والتخزين — يعمل مباشرة على lib/ بلا HTTP.
 * 1) يولّد فيديوهين مختلفي الدقة بـ ffmpeg (أحدهما بصوت والآخر صامت)
 * 2) يدمجهما ويتحقق: اكتمال الدمج، الدقة = أكبر دقة مدخل، المدة ≈ مجموع المدد، وجود الصوت
 * 3) يختبر التخزين في Turso والاسترجاع بتطابق sha256
 * 4) يختبر مسار رفع الأجزاء، حدود الحجم، والحذف الشامل
 * التشغيل: node scripts/test-unit.js
 */

process.env.OUTPUT_MAX_MB = process.env.OUTPUT_MAX_MB || "150";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { ffmpegBin } = require("../lib/merge");
const db = require("../lib/db");
const { runMergeJob, probeFile } = require("../lib/merge");

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

async function makeTestVideo(dest, width, height, seconds, withAudio) {
  const ffmpeg = await ffmpegBin();
  const audio = withAudio ? `-f lavfi -i sine=frequency=440:duration=${seconds}` : "";
  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc=size=${width}x${height}:rate=30:duration=${seconds}`,
  ];
  if (withAudio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p");
  if (withAudio) args.push("-c:a", "aac", "-shortest");
  args.push(dest);
  const r = spawnSync(ffmpeg, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg فشل: ${r.stderr.slice(-300)}`);
  return dest;
}

async function main() {
  console.log("\n=== اختبار محرك الدمج والتخزين ===\n");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-unit-"));

  // 1) توليد فيديوهين مختلفي الدقة
  console.log("[1] توليد مقطعَي اختبار بـ ffmpeg…");
  const v1 = await makeTestVideo(path.join(tmp, "v1.mp4"), 1280, 720, 4, true); // بصوت
  const v2 = await makeTestVideo(path.join(tmp, "v2.mp4"), 640, 360, 3, false); // صامت
  const p1 = await probeFile(v1);
  const p2 = await probeFile(v2);
  check("المصدر الأول 1280x720 وله صوت", p1.width === 1280 && p1.height === 720 && p1.hasAudio);
  check("المصدر الثاني 640x360 صامت", p2.width === 640 && p2.height === 360 && !p2.hasAudio);

  // 2) مهمة دمج بمصادر ملفات مرفوعة (مسار الأجزاء)
  console.log("\n[2] رفع المصادر كأجزاء وتنفيذ الدمج…");
  const jobId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  await db.insertJob({
    id: jobId,
    status: "uploading",
    sources_json: JSON.stringify([
      { kind: "file", name: "v1.mp4", size: fs.statSync(v1).size, mime: "video/mp4" },
      { kind: "file", name: "v2.mp4", size: fs.statSync(v2).size, mime: "video/mp4" },
    ]),
    expires_at: expiresAt,
  });
  // محاكاة رفع الأجزاء (2MB لكل صف كما في الإنتاج)
  const b1 = fs.readFileSync(v1);
  const b2 = fs.readFileSync(v2);
  await db.saveBlobRows("source_chunks", ["job_id", "source_seq"], [jobId, 0], b1);
  await db.saveBlobRows("source_chunks", ["job_id", "source_seq"], [jobId, 1], b2);
  const gotSize = await db.readBlobSize("source_chunks", ["job_id", "source_seq"], [jobId, 0]);
  check("أجزاء المصدر الأول مخزنة بالحجم الصحيح", gotSize === b1.length, `${gotSize} != ${b1.length}`);

  const result = await runMergeJob(jobId, "http://localhost:8787");
  const job = result.job || (await db.getJob(jobId));
  check("اكتمل الدمج (done)", job && job.status === "done", `status=${job && job.status} err=${job && job.error}`);
  check("الدقة = أكبر دقة مدخل (1280x720)", job.resolution === "1280x720", job.resolution);
  const expectedDuration = p1.duration + p2.duration;
  check(`المدة ≈ مجموع المدد (${expectedDuration}s)`, Math.abs(job.duration - expectedDuration) < 1.5, `${job.duration}`);
  const outLocal = path.join(tmp, "out.mp4");
  const outInfo = await probeOfUrl(job.video_url, outLocal);
  check("الناتج يحتوي مسار صوت (أُضيف صمت للمصدر الصامت)", outInfo.hasAudio);
  check("حجم الناتج منطقي (> 100KB)", job.size > 100 * 1024, String(job.size));

  // 3) التخزين والاسترجاع بتطابق sha256
  console.log("\n[3] التحقق من التخزين في Turso والاسترجاع بتطابق sha256…");
  const blob1 = crypto.randomBytes(1024 * 1024 + 123456); // أكبر من صف 2MB? لا — نستخدم حجمين
  const blob2 = crypto.randomBytes(5 * 1024 * 1024 + 777); // أكبر من صف (5MB → 3 صفوف)
  const testId = crypto.randomUUID();
  await db.saveBlobRows("output_chunks", ["job_id"], [testId], blob2);
  let reassembled = Buffer.alloc(0);
  await db.streamBlobRange("output_chunks", ["job_id"], [testId], 0, blob2.length - 1, async (buf) => {
    reassembled = Buffer.concat([reassembled, buf]);
  });
  const h1 = crypto.createHash("sha256").update(blob2).digest("hex");
  const h2 = crypto.createHash("sha256").update(reassembled).digest("hex");
  check("sha256 متطابق بعد التخزين والاسترجاع (5MB عبر 3 صفوف)", h1 === h2);
  // مجال أوسط (Range) بتطابق جزئي
  let mid = Buffer.alloc(0);
  await db.streamBlobRange("output_chunks", ["job_id"], [testId], 1000, 1048600, async (buf) => {
    mid = Buffer.concat([mid, buf]);
  });
  const h3 = crypto.createHash("sha256").update(blob2.subarray(1000, 1048601)).digest("hex");
  const h4 = crypto.createHash("sha256").update(mid).digest("hex");
  check("قراءة مجال أوسط (Range) بتطابق sha256 جزئي", h3 === h4 && mid.length === 1048601 - 1000);
  await db.getDb().execute({ sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [testId] });
  void blob1;

  // 4) حد حجم الناتج
  console.log("\n[4] اختبار حد حجم الناتج…");
  process.env.OUTPUT_MAX_MB = "0.1"; // حد 0.1MB (الناتج الفعلي ~200KB) → فشل واضح (الحد يُقرأ عند كل نداء)
  const jobId2 = crypto.randomUUID();
  await db.insertJob({
    id: jobId2,
    status: "queued",
    sources_json: JSON.stringify([
      { kind: "file", name: "v1.mp4", size: fs.statSync(v1).size, mime: "video/mp4" },
      { kind: "file", name: "v2.mp4", size: fs.statSync(v2).size, mime: "video/mp4" },
    ]),
    expires_at: expiresAt,
  });
  await db.saveBlobRows("source_chunks", ["job_id", "source_seq"], [jobId2, 0], b1);
  await db.saveBlobRows("source_chunks", ["job_id", "source_seq"], [jobId2, 1], b2);
  const r2 = await runMergeJob(jobId2, "http://localhost:8787");
  const j2 = await db.getJob(jobId2);
  check("تجاوز حد الناتج → فشل واضح برسالة", j2.status === "failed" && /حد/.test(j2.error || ""), j2.error);

  // 5) الحذف الشامل
  console.log("\n[5] اختبار الحذف الشامل…");
  await db.deleteJobCascade(jobId);
  await db.deleteJobCascade(jobId2);
  const gone = await db.getJob(jobId);
  const chunksGone = await db.getDb().execute({ sql: `SELECT COUNT(*) AS c FROM source_chunks WHERE job_id IN (?,?)`, args: [jobId, jobId2] });
  check("المهمة محذوفة", gone === null);
  check("كل الأجزاء محذوفة", Number(chunksGone.rows[0].c) === 0);

  // تنظيف مجلد المؤقت
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n=== النتيجة: ${passed} نجح / ${failed} فشل ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

async function probeOfUrl(url, dest) {
  spawnSync("curl", ["-fsSL", "-o", dest, url]);
  return probeFile(dest);
}

main().catch((e) => {
  console.error("فشل الاختبار:", e);
  process.exit(1);
});
