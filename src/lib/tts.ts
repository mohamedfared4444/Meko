/**
 * توليد التعليق الصوتي (Voiceover) مجانًا وبلا حدود عبر Edge-TTS —
 * خدمة Microsoft Edge Read Aloud (websocket) بحزمة msedge-tts:
 * صوت عصبي طبيعي، صيغة MP3 (24kHz / 48kbit mono)، أصوات إنجليزية وعربية.
 *
 * الصوت الافتراضي en-US-AndrewNeural مع كتالوج أصوات مدعومة
 * (en-US-AriaNeural، en-US-GuyNeural، ar-EG-ShakirNeural، ar-SA-HamedNeural…)
 * وتحكم في سرعة النطق rate (+10% / -15% …) وطبقة النبرة pitch (+0Hz / -2Hz …)
 * لإلقاء أكثر حيوية وطبيعية.
 *
 * مدة الملف بالثواني تُحسب بدقة من عدّ إطارات MP3 نفسها (محوّل CBR ثابت
 * 48kbit/24kHz من Edge) — بلا اعتماد على ffprobe داخل التطبيق الرئيسي.
 *
 * الناتج يُرفع عبر سلسلة الرفع الموثوقة المشتركة (tmpfiles → uguu → litterbox
 * → catbox → 0x0.st → data URL) — السلسلة لا تُلقي أبدًا فلا تفشل الأداة
 * إلا لسبب التوليد نفسه.
 */

import { uploadViaHosts } from "./upload";
import { buildSrt, parseEdgeMetadata, type WordTiming } from "./captions";

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

/** سرعة الإلقاء الافتراضية لـ Edge-TTS — إيقاع وثائقي هادئ (-7%) يمنح المشاهِد
 *  مساحةً لمتابعة الترجمة الحركية المدمجة؛ تُتجاوز عند تمرير rate صريح للمولّد. */
export const DEFAULT_TTS_RATE = "-7%";

/**
 * تنقية طبقة النبرة — تقبل +0Hz / -2Hz / +3st … وتقصر إلى ±50Hz.
 * «+0Hz» أو القيم الصفرية تعني «بلا تغيير» فتعيد undefined (لا تُمرر لـ Edge).
 */
export function sanitizePitch(pitch?: string): string | undefined {
  const raw = (pitch ?? "").trim();
  let m = raw.match(/^([+-])(\d{1,2})Hz$/i);
  if (m) {
    const hz = Math.min(50, Number(m[2]));
    return hz > 0 ? `${m[1]}${hz}Hz` : undefined;
  }
  // نصف نغمات (+2st) — SSML يقبلها أيضًا، نمررها كما هي بعد تحقق الشكل
  m = raw.match(/^([+-])(\d{1,2})st$/i);
  if (m && Number(m[2]) > 0 && Number(m[2]) <= 25) return `${m[1]}${Number(m[2])}st`;
  return undefined;
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
  /** توقيتات الكلمات من Edge (WordBoundary/SentenceBoundary) — عند طلبها فقط */
  words?: WordTiming[];
}

/** توليد تعليق صوتي MP3 من نص — يعيد البايتات والمدة الدقيقة بالثواني
 *  (واختياريًا توقيتات كل كلمة لبناء الترجمة المتزامنة من نفس نداء Edge).
 *  rate وpitch اختياريان للتحكم في الإلقاء (+10%، -2Hz …) — بدون rate صريح
 *  يُستخدم الافتراضي الهادئ DEFAULT_TTS_RATE (-7%). */
export async function synthesizeSpeech(
  text: string,
  opts: { voice?: string; rate?: string; pitch?: string; timeoutMs?: number; collectTimings?: boolean } = {},
): Promise<TtsResult> {
  const narration = text.trim();
  if (!narration) throw new Error("النص المطلوب نطقه فارغ");
  if (narration.length > 6000) throw new Error("النص طويل جدًا للتحويل الصوتي (الحد 6000 حرفًا) — قسّمه إلى مقاطع");

  const voice = normalizeVoice(opts.voice);
  // الافتراضي هادئ (-7%) — إيقاع وثائقي مريح؛ الصريح من المستدعي يتجاوزه
  const rate = sanitizeRate(opts.rate) ?? DEFAULT_TTS_RATE;
  const pitch = sanitizePitch(opts.pitch);

  const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
  const tts = new MsEdgeTTS();
  // تفعيل حدود الكلمات والجمل في metadata — تكلفتها ترف صغيرة وهي مصدر
  // التوقيتات الدقيقة للترجمة المتزامنة (نفس نداء الصوت، بلا خدمات إضافية)
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
    wordBoundaryEnabled: true,
    sentenceBoundaryEnabled: true,
  });

  // مهلة صارمة: فشل websocket المعلّق لا يجوز أن يمسك المهمة للأبد
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const prosody = rate || pitch ? { ...(rate ? { rate } : {}), ...(pitch ? { pitch } : {}) } : undefined;
    const { audioStream, metadataStream } = tts.toStream(narration, prosody);
    const collect = async (stream: AsyncIterable<Buffer | Uint8Array>, tolerate: boolean): Promise<Buffer> => {
      const parts: Buffer[] = [];
      try {
        for await (const chunk of stream) parts.push(Buffer.from(chunk as Buffer));
      } catch (e) {
        // تدفق الميتاداتا يُغلق أحيانًا بقيمة «Premature close» بعد اكتمال الصوت
        // — بياناته المجمّعة كافية للترجمة؛ أما تدفق الصوت فيجب أن ينجح كاملًا
        if (!tolerate) throw e;
      }
      return Buffer.concat(parts);
    };
    const [audio, meta] = await Promise.all([
      collect(audioStream as AsyncIterable<Buffer | Uint8Array>, false),
      metadataStream ? collect(metadataStream as AsyncIterable<Buffer | Uint8Array>, true) : Promise.resolve(Buffer.alloc(0)),
    ]);
    if (audio.length < 512) {
      throw new Error(`ناتج Edge-TTS فارغ أو تالف (${audio.length} بايت)`);
    }
    const words = opts.collectTimings ? parseEdgeMetadata(meta) : undefined;
    return { mp3: new Uint8Array(audio), durationSec: mp3DurationSeconds(audio), voice, words: words && words.length > 0 ? words : undefined };
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
 * captions: بناء ملف ترجمة SRT من توقيتات Edge ورفعه — فشل الترجمة
 * (رفع/بناء) لا يُفشل الصوت أبدًا؛ يعيد captionsUrl غير معرف فقط.
 */
export async function generateVoiceover(
  text: string,
  opts: { voice?: string; rate?: string; pitch?: string; remainingMs?: () => number; captions?: boolean } = {},
): Promise<{ url: string; durationSec: number; voice: string; captionsUrl?: string }> {
  const res = await synthesizeSpeech(text, { voice: opts.voice, rate: opts.rate, pitch: opts.pitch, collectTimings: opts.captions === true });
  const url = await uploadViaHosts(res.mp3, "audio/mpeg", opts.remainingMs);
  let captionsUrl: string | undefined;
  if (opts.captions && res.words && res.words.length >= 2) {
    try {
      const srt = buildSrt(res.words.map((w) => ({ ...w })));
      if (srt.trim()) {
        captionsUrl = await uploadViaHosts(new TextEncoder().encode(srt), "application/x-subrip", opts.remainingMs);
      }
    } catch {
      /* الترجمة إضافة اختيارية — فشلها لا يمس الصوت أبدًا */
    }
  }
  return { url, durationSec: res.durationSec, voice: res.voice, captionsUrl };
}
