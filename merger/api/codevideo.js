/**
 * POST /api/codevideo — فيديو الأنيميشن البرمجي (Code-Driven Motion Graphics).
 *
 * الجسم: {"html_code":"<!doctype html>… صفحة ذاتية الاحتواء تعرّف
 *         window.renderAtTime(t, duration, wordTimings)",
 *         "audio_url":"https://…/audio.mp3" (اختياري — يحدد المدة عند وجوده),
 *         "duration_seconds":15 (اختياري — الافتراضي 15، الأقصى 60، بلا صوت),
 *         "fps":24 (اختياري 8–30), "width":720, "height":1280,
 *         "word_timings":[{"start":0.1,"end":0.4,"text":"…"}] (اختياري)}
 *
 * التدفق متزامن داخل الطلب: Chromium يلتقط إطارًا لكل لحظة t ويضخه عبر
 * stdin (image2pipe) في ffmpeg مع دمج الصوت — الناتج MP4 (H.264/yuv420p)
 * يُخزَّن في نفس نظام المهام ويُخدم عبر /api/jobs/{id}/video.
 * maxDuration يأتي من vercel.json (دوال مسار api — حد 60 ثانية).
 */

const { handleCodeVideo } = require("../lib/codevideo-endpoint");

module.exports = async (req, res) => handleCodeVideo(req, res);
