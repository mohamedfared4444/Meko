/**
 * POST /api/videocut — تحريك مصفوفة صور وتحويلها إلى فيديو MP4 سينمائي.
 *
 * الجسم: {"images":["https://…","data:image/…"], "audio_url":"https://…/audio.mp3",
 *         "aspect_ratio":"9:16"|"16:9", "transition":0.6, "resolution":"720p"|"1080p",
 *         "total_duration":30}
 *
 * التدفق متزامن داخل الطلب (مثل /process): إنشاء مهمة → Ken Burns + Crossfade
 * + مزج الصوت عبر ffmpeg → تخزين الناتج → رابط مباشر بنفس صيغة مهام الدمج.
 * maxDuration يأتي من vercel.json (دوال مسار api — حد 60 ثانية).
 */

const { handleVideocut } = require("../lib/videocut-endpoint");

module.exports = async (req, res) => handleVideocut(req, res);
