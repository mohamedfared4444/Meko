/**
 * اختبار HTTP كامل ضد خادم التطوير (localhost:8787):
 * إنشاء مهمة من روابط → دمج → بث مع Range 206 → مهمة مختلطة (رابط + ملف مرفوع)
 * → حذف → 404 → JSON تالف → قائمة فارغة → الحدود.
 * التشغيل: أطلق الخادم أولًا (node server.js) ثم node scripts/test-http.js
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const BASE = process.env.TEST_BASE || "http://localhost:8787";
const URL_A = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";
const URL_B = "https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_1MB.mp4";

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

async function api(method, pathName, { body, raw, headers } = {}) {
  const res = await fetch(BASE + pathName, {
    method,
    headers: headers ?? (body !== undefined ? { "Content-Type": "application/json" } : {}),
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ليست JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function main() {
  console.log(`\n=== اختبار HTTP كامل ضد ${BASE} ===\n`);

  // 0) config
  const cfg = await api("GET", "/api/config");
  check("GET /api/config → 200 مع الحدود", cfg.status === 200 && cfg.json.maxSources === 10);

  // 1) مهمة من روابط
  console.log("[1] مهمة دمج من روابط…");
  const created = await api("POST", "/api/jobs", { body: { videos: [URL_A, URL_B] } });
  check("POST /api/jobs → 201 مع jobId و statusUrl و processUrl", created.status === 201 && !!created.json.jobId && !!created.json.statusUrl && !!created.json.processUrl);
  const jobId = created.json.jobId;

  const processed = await api("POST", `/api/jobs/${jobId}/process`);
  check("POST process → done مع videoUrl و resolution", processed.status === 200 && processed.json.status === "done" && !!processed.json.videoUrl, JSON.stringify(processed.json).slice(0, 200));
  check("الدقة 1280x720 (أكبر دقة)", processed.json.resolution === "1280x720", processed.json.resolution);

  // 2) بث مع Range
  console.log("\n[2] بث الناتج…");
  const full = await fetch(BASE + `/api/jobs/${jobId}/video`);
  const totalSize = Number(full.headers.get("content-length"));
  const buf = Buffer.from(await full.arrayBuffer());
  check("GET video → 200 بحجم الناتج الكامل", full.status === 200 && buf.length === totalSize && buf.length > 100000);
  const ranged = await fetch(BASE + `/api/jobs/${jobId}/video`, { headers: { Range: "bytes=100-1099" } });
  const rbuf = Buffer.from(await ranged.arrayBuffer());
  check("Range → 206 مع Content-Range وطول صحيح", ranged.status === 206 && rbuf.length === 1000 && ranged.headers.get("content-range") === `bytes 100-1099/${totalSize}`);
  check("المجال المقطوع يطابق الأصل بايت ببايت", rbuf.equals(buf.subarray(100, 1100)));
  const suffix = await fetch(BASE + `/api/jobs/${jobId}/video`, { headers: { Range: "bytes=-500" } });
  const sbuf = Buffer.from(await suffix.arrayBuffer());
  check("لاحقة Range (آخر 500 بايت) تعمل", suffix.status === 206 && sbuf.length === 500 && sbuf.equals(buf.subarray(totalSize - 500)));

  // 3) مهمة مختلطة (رابط + ملف مرفوع بالأجزاء)
  console.log("\n[3] مهمة مختلطة (رابط + ملف مرفوع)…");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-http-"));
  const localClip = path.join(tmp, "clip.mp4");
  // نولّد مقطعًا محليًا بـ ffmpeg من الحزمة
  const ffmpegPath = require("../node_modules/ffmpeg-static");
  const gen = spawnSync(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=960x540:rate=30:duration=3", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", localClip], { encoding: "utf8" });
  check("توليد مقطع محلي للاختبار", gen.status === 0 && fs.existsSync(localClip));
  const clipBuf = fs.readFileSync(localClip);

  const mixed = await api("POST", "/api/jobs", {
    body: { sources: [{ kind: "url", url: URL_A }, { kind: "file", name: "clip.mp4", size: clipBuf.length, mime: "video/mp4" }] },
  });
  check("إنشاء مهمة مختلطة → 201 مع uploads[]", mixed.status === 201 && Array.isArray(mixed.json.uploads) && mixed.json.uploads.length === 2);
  const mixedId = mixed.json.jobId;
  // رفع الملف على أجزاء 1MB عبر HTTP
  const CH = 1024 * 1024;
  const chunks = Math.ceil(clipBuf.length / CH);
  let uploadsOk = true;
  for (let k = 0; k < chunks; k++) {
    const part = clipBuf.subarray(k * CH, Math.min((k + 1) * CH, clipBuf.length));
    const up = await fetch(`${BASE}/api/upload?job=${mixedId}&seq=1&chunk=${k}`, { method: "POST", body: part, headers: { "Content-Type": "application/octet-stream" } });
    if (!up.ok) uploadsOk = false;
  }
  check(`رفع الملف على ${chunks} أجزاء عبر HTTP`, uploadsOk);
  const mixedProc = await api("POST", `/api/jobs/${mixedId}/process`);
  check("دمج المهمة المختلطة → done", mixedProc.status === 200 && mixedProc.json.status === "done", JSON.stringify(mixedProc.json).slice(0, 200));
  check("دقة المهمة المختلطة = 960x540 (أكبر دقة بين الرابط 640x360 والملف 960x540)", mixedProc.json.resolution === "960x540", mixedProc.json.resolution);

  // 4) الحذف الفوري
  console.log("\n[4] الحذف والفحوص السلبية…");
  const del = await api("DELETE", `/api/jobs/${mixedId}`);
  check("DELETE → 200", del.status === 200);
  const afterDel = await api("GET", `/api/jobs/${mixedId}`);
  check("GET بعد الحذف → 404", afterDel.status === 404);
  const videoGone = await api("GET", `/api/jobs/${mixedId}/video`);
  check("video بعد الحذف → 404", videoGone.status === 404);

  const missing = await api("GET", `/api/jobs/${crypto.randomUUID()}`);
  check("مهمة غير موجودة → 404", missing.status === 404);

  // 5) JSON تالف ومدخلات ناقصة
  const bad = await fetch(BASE + "/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{invalid json" });
  check("JSON تالف → 400", bad.status === 400);
  const empty = await api("POST", "/api/jobs", { body: { videos: [] } });
  check("قائمة فارغة → 400 برسالة عربية", empty.status === 400 && /مقطع|رابط/.test(empty.json.error || ""));
  const eleven = await api("POST", "/api/jobs", { body: { videos: Array.from({ length: 11 }, () => URL_A) } });
  check("11 مقطعًا → 400 (أقصى 10)", eleven.status === 400);
  const one = await api("POST", "/api/jobs", { body: { videos: [URL_A] } });
  check("مقطع واحد يُقبل الإنشاء لكن process يرفض", one.status === 201 && (await api("POST", `/api/jobs/${one.json.jobId}/process`)).status === 400);
  await api("DELETE", `/api/jobs/${one.json.jobId}`);

  const wrongMethod = await api("PUT", "/api/config");
  check("طريقة خاطئة → 405", wrongMethod.status === 405);

  // تنظيف مهمة الروابط الأولى
  await api("DELETE", `/api/jobs/${jobId}`);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n=== النتيجة: ${passed} نجح / ${failed} فشل ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("فشل الاختبار:", e);
  process.exit(1);
});
