/**
 * توليد التعليق الصوتي (Voiceover) مجانًا وبلا حدود عبر Edge-TTS —
 * خدمة Microsoft Edge Read Aloud (websocket) بحزمة msedge-tts:
 * صوت عصبي طبيعي، صيغة MP3 (24kHz / 48kbit mono)، أصوات إنجليزية وعربية.
 *
 * الصوت الافتراضي en-US-AndrewNeural مع كتالوج أصوات مدعومة
 * (en-US-AriaNeural، en-US-GuyNeural، ar-EG-ShakirNeural، ar-SA-HamedNeural…)
 * وتحكم في سرعة النطق rate (+10% / -15% …).
 *
 * مدة الملف بالثواني تُحسب بدقة من عدّ إطارات MP3 نفسها (محوّل CBR ثابت
 * 48kbit/24kHz من Edge) — بلا اعتماد على ffprobe داخل التطبيق الرئيسي.
 *
 * الناتج يُرفع عبر سلسلة الرفع الموثوقة المشتركة (tmpfiles → uguu → litterbox
 * → catbox → 0x0.st → data URL) — السلسلة لا تُلقي أبدًا فلا تفشل الأداة
 * إلا لسبب التوليد نفسه.
 */

import { uploadViaHosts } from "./upload";

/** الصوت الافتراضي */
export const DEFAULT_VOICE = "en-US-AndrewNeural";
/** صيغة الصوت الافتراضية من Edge — MP3 جاهز للويب */
const OUTPUT_FORMAT = "AUDIO_24KHZ_48KBITRATE_MONO_MP3" as const;

/** كتالوج الأصوات المدعومة (مجموعة مختارة عالية الجودة) */
export const SUPPORTED_VOICES: string[] = [
  "en-US-AndrewNeural",
  "en-US-AriaNeural",
  "en-US-GuyNeural",
  "en-US-EmmaNeural",
  "en-US-BrianNeural",
  "en-GB-RyanNeural",
  "en-GB-SoniaNeural",
  "ar-EG-ShakirNeural",
  "ar-SA-HamedNeural",
  "ar-EG-SalmaNeural",
];

/** هل الصوت مدعوم؟ (يتسامح مع اختلاف حالة الأحرف وينهي بالاسم القياسي) */
export function normalizeVoice(voice?: string): string {
  const v = (voice ?? "").trim();
  if (!v) return DEFAULT_VOICE;
  const found = SUPPORTED_VOICES.find((s) => s.toLowerCase() === v.toLowerCase());
  if (found) return found;
  // صوت خارج الكتالوج بصيغة Neural سليمة؟ نمرره كما هو (Microsoft قد أضاف أصواتًا جديدة)
  if (/^[a-z]{2}-[A-Z]{2}-\w+Neural$/i.test(v)) return v;
  return DEFAULT_VOICE;
}

/** تنقية سرعة النطق — تقبل +10% / -15% … وتقصر إلى حدود معقولة */
export function sanitizeRate(rate?: string): string | undefined {
  const m = (rate ?? "").trim().match(/^([+-])(\d{1,2})%$/);
  if (!m) return undefined;
  const pct = Math.min(50, Math.max(5, Number(m[2])));
  return `${m[1]}${pct}%`;
}

// ---------------------------------------------------------------------------
// محلل مدة MP3 — عدّ الإطارات من ترويسات MPEG (يعمل مع CBR/VBR بلا Xing)

interface Mp3Header {
  samplesPerFrame: number;
  sampleRate: number;
  frameSize: number;
}

/** ترويسة MPEG 4 بايت → معاملات الإطار، أو null إن لم تكن ترويسة صالحة */
function parseMp3Header(b: Uint8Array, i: number): Mp3Header | null {
  if (i + 4 > b.length) return null;
  const a = b[i];
  const c = b[i + 1];
  const d = b[i + 2];
  if (a !== 0xff || (c & 0xe0) !== 0xe0) return null;

  const versionBits = (c >> 3) & 0x03; // 00=MPEG2.5, 10=MPEG2, 11=MPEG1
  const layerBits = (c >> 1) & 0x03; // 01=Layer3
  if (versionBits === 1 || layerBits !== 0x01) return null; // Layer3 فقط

  // معدلات البت (kbps) للـ Layer3 حسب الإصدار
  const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const SR_MPEG1 = [44100, 48000, 32000, 0];
  const SR_MPEG2 = [22050, 24000, 16000, 0];
  const SR_MPEG25 = [11025, 12000, 8000, 0];

  const bitrateIdx = (d >> 4) & 0x0f;
  const srIdx = (d >> 2) & 0x03;
  const padding = (d >> 1) & 0x01;
  if (bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null;

  let sampleRate: number;
  let samplesPerFrame: number;
  let bitrate: number;
  if (versionBits === 3) {
    // MPEG1
    sampleRate = SR_MPEG1[srIdx];
    samplesPerFrame = 1152;
    bitrate = BR1[bitrateIdx] * 1000;
  } else {
    // MPEG2 / MPEG2.5
    sampleRate = versionBits === 2 ? SR_MPEG2[srIdx] : SR_MPEG25[srIdx];
    samplesPerFrame = 576;
    bitrate = BR2[bitrateIdx] * 1000;
  }
  if (!sampleRate || !bitrate) return null;

  const coef = versionBits === 3 ? 144 : 72;
  const frameSize = Math.floor((coef * bitrate) / sampleRate) + padding;
  return { samplesPerFrame, sampleRate, frameSize };
}

/**
 * مدة ملف MP3 بالثواني من عدّ الإطارات — يعمل مع ناتج Edge (CBR) وأي MP3
 * سليم. إن فشل التحليل (ملف تالف) يعيد تقديرًا من معدل البت الافتراضي 48kbit.
 */
export function mp3DurationSeconds(bytes: Uint8Array): number {
  let frames = 0;
  let i = 0;
  let lastValid: Mp3Header | null = null;
  while (i + 4 <= bytes.length) {
    const h = parseMp3Header(bytes, i);
    if (!h) {
      i++;
      continue;
    }
    frames++;
    lastValid = h;
    i += h.frameSize > 0 ? h.frameSize : 1;
  }
  if (frames === 0 || !lastValid) {
    // تقدير احتياطي — ناتج Edge ثابت 48kbit
    return (bytes.length * 8) / 48_000;
  }
  return (frames * lastValid.samplesPerFrame) / lastValid.sampleRate;
}

// ---------------------------------------------------------------------------
// التوليد عبر Edge-TTS

/** نتيجة توليد الصوت */
export interface TtsResult {
  mp3: Uint8Array;
  durationSec: number;
  voice: string;
}

/** توليد تعليق صوتي MP3 من نص — يعيد البايتات والمدة الدقيقة بالثواني */
export async function synthesizeSpeech(
  text: string,
  opts: { voice?: string; rate?: string; timeoutMs?: number } = {},
): Promise<TtsResult> {
  const narration = text.trim();
  if (!narration) throw new Error("النص المطلوب نطقه فارغ");
  if (narration.length > 6000) throw new Error("النص طويل جدًا للتحويل الصوتي (الحد 6000 حرفًا) — قسّمه إلى مقاطع");

  const voice = normalizeVoice(opts.voice);
  const rate = sanitizeRate(opts.rate);

  const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  // مهلة صارمة: فشل websocket المعلّق لا يجوز أن يمسك المهمة للأبد
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const { audioStream } = tts.toStream(narration, rate ? { rate } : undefined);
    const chunks: Buffer[] = [];
    for await (const chunk of audioStream as AsyncIterable<Buffer | Uint8Array>) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    const mp3 = Buffer.concat(chunks);
    if (mp3.length < 512) {
      throw new Error(`ناتج Edge-TTS فارغ أو تالف (${mp3.length} بايت)`);
    }
    return { mp3: new Uint8Array(mp3), durationSec: mp3DurationSeconds(mp3), voice };
  } finally {
    clearTimeout(timer);
    try {
      tts.close();
    } catch {
      /* تجاهل */
    }
  }
}

/**
 * توليد + رفع في خطوة واحدة — يعيد الرابط المباشر والمدة.
 * الرفع عبر السلسلة الموثوقة (لا يُلقي أبدًا؛ data URL كحل أخير).
 */
export async function generateVoiceover(
  text: string,
  opts: { voice?: string; rate?: string; remainingMs?: () => number } = {},
): Promise<{ url: string; durationSec: number; voice: string }> {
  const res = await synthesizeSpeech(text, { voice: opts.voice, rate: opts.rate });
  const url = await uploadViaHosts(res.mp3, "audio/mpeg", opts.remainingMs);
  return { url, durationSec: res.durationSec, voice: res.voice };
}
