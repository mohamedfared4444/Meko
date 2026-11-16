/**
 * الترجمة المتزامنة التلقائية (Auto Captions) — مجانية بالكامل:
 * توقيتات الكلمات (WordBoundary) وحدود الجمل (SentenceBoundary) تُستخرج من
 * Edge-TTS أثناء توليد الصوت نفسه (بلا خدمات مدفوعة وبلا تحليل صوتي)، ثم
 * تُجمَّع الكلمات في أسطر ترجمة قصيرة مقروءة وتُكتب كملف SRT نظيف.
 *
 * الملف الناتج يُطبَع لاحقًا على الفيديو عبر FFmpeg (libass) في meko-manger
 * مع خط يدعم العربية (Noto Sans Arabic مضمّن في الخدمة) — libass/fribidi
 * يتكفلان بتشكيل الحروف العربية واتجاه RTL تلقائيًا.
 *
 * ملاحظة توقيتات: Edge-TTS يعطي Offset/Duration بوحدات 100 نانوثانية (ticks)
 * — القسمة على 10 ملايين تعطي الثواني.
 */

export interface WordTiming {
  /** بداية الكلمة بالثواني (نسبيًا لبداية الصوت) */
  start: number;
  /** نهاية الكلمة بالثواني */
  end: number;
  /** نص الكلمة كما نطِقتها Edge-TTS */
  text: string;
  /** هل تبدأ مع هذه الكلمة جملة جديدة معلنة من Edge (SentenceBoundary)؟ */
  sentenceStart?: boolean;
}

/** أقصى طول سطر ترجمة بالأحرف — مقروء على فيديو عمودي */
const MAX_CUE_CHARS = 48;
/** أقصى مدة لسطر ترجمة واحد */
const MAX_CUE_SECONDS = 4.2;

/** هل الكلمة تنهي جملةً منطقيًا (نقطتان/علامة استفهام/تعجب/حذف)؟ */
function endsSentence(word: string): boolean {
  return /[.!?؟…]["»)]?$/.test(word.trim());
}

/** هل الكلمة تنهي جملة فرعية (فاصلة/فاصلة منقوطة)؟ */
function endsClause(word: string): boolean {
  return /[،,;؛:]$/.test(word.trim());
}

/**
 * فصل كائنات JSON متتالية (تدفق metadataStream من Edge يرسل كائنات ملتصقة
 * بلا فواصل) — ماسح متوازن يحترم السلاسل النصية والأقواس داخلها.
 */
function splitJsonObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      if (depth === 0) start = i;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/**
 * تحويل تدفق metadata الخام من Edge-TTS إلى توقيتات كلمات بالثواني.
 * يقبل Buffer أو نصًا؛ يتجاهل أي كتلة غير قابلة للتحليل بصمت (المetadata
 * قد تتقطع عند إغلاق المقبس — نأخذ ما وصل منه، وهو كافٍ للترجمة).
 */
export function parseEdgeMetadata(raw: Buffer | Uint8Array | string): WordTiming[] {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  if (!text.trim()) return [];
  const words: WordTiming[] = [];
  // حدود الجمل المعلمة بالإزاحة — لمطابقتها مع بداية الكلمة نفسها
  const sentenceOffsets = new Set<number>();
  for (const block of splitJsonObjects(text)) {
    let obj: { Metadata?: Array<{ Type?: string; Data?: { Offset?: unknown; Duration?: unknown; text?: { Text?: unknown } } }> };
    try {
      obj = JSON.parse(block);
    } catch {
      continue;
    }
    for (const m of obj.Metadata ?? []) {
      const offsetTicks = Number(m.Data?.Offset ?? NaN);
      const durTicks = Number(m.Data?.Duration ?? NaN);
      if (!Number.isFinite(offsetTicks)) continue;
      const start = offsetTicks / 10_000_000;
      const dur = Number.isFinite(durTicks) && durTicks > 0 ? durTicks / 10_000_000 : 0;
      const txt = typeof m.Data?.text?.Text === "string" ? m.Data.text.Text : "";
      if (m.Type === "SentenceBoundary") {
        sentenceOffsets.add(offsetTicks);
        continue;
      }
      if (!txt.trim()) continue;
      words.push({ start, end: Math.max(start + dur, start + 0.06), text: txt.trim() });
    }
  }
  words.sort((a, b) => a.start - b.start);
  // بداية جملة معلنة عند إزاحة كلمة ما → فاصل ترجمة قبلها (نهاية الجملة السابقة)
  for (const w of words) {
    const ticks = Math.round(w.start * 10_000_000);
    if (sentenceOffsets.has(ticks) || sentenceOffsets.has(Math.round(w.start * 10_000_000) + 1) || sentenceOffsets.has(Math.round(w.start * 10_000_000) - 1)) {
      w.sentenceStart = true;
    }
  }
  return words;
}

/** ثانية → «HH:MM:SS,mmm» بصيغة SRT */
function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rest, 3)}`;
}

/** تجميع توقيتات الكلمات في أسطر ترجمة قصيرة مقروءة */
export function buildCues(words: WordTiming[]): Array<{ start: number; end: number; text: string }> {
  const clean = words.filter((w) => w.text && w.end > w.start);
  if (clean.length === 0) return [];
  const cues: Array<{ start: number; end: number; text: string }> = [];
  let buf: WordTiming[] = [];

  const flush = (nextStart: number | null) => {
    if (buf.length === 0) return;
    const first = buf[0];
    const last = buf[buf.length - 1];
    let end = last.end;
    if (nextStart !== null) {
      end = Math.max(end, Math.min(nextStart - 0.06, last.end + 0.55));
    } else {
      end = last.end + 0.9; // آخر سطر يبقى ظاهرًا قليلًا بعد آخر كلمة
    }
    if (end <= first.start) end = first.start + 0.4;
    cues.push({ start: first.start, end, text: buf.map((w) => w.text).join(" ") });
    buf = [];
  };

  for (let i = 0; i < clean.length; i++) {
    const w = clean[i];
    const prev = buf[buf.length - 1];
    const chars = buf.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    const dur = w.end - (buf[0]?.start ?? w.start);
    if (prev) {
      const gap = w.start - prev.end;
      const prevSentence = endsSentence(prev.text);
      const prevClause = endsClause(prev.text);
      const hardBreak =
        prevSentence || // نهاية جملة → فاصل دائمًا
        w.sentenceStart === true || // Edge أعلن بداية جملة جديدة هنا
        chars > MAX_CUE_CHARS ||
        dur > MAX_CUE_SECONDS ||
        gap > 0.75 ||
        buf.length >= 6;
      const softBreak = prevClause && buf.length >= 3;
      if (hardBreak || softBreak) flush(w.start);
    }
    buf.push(w);
  }
  flush(null);
  return cues;
}

/** بناء ملف SRT كامل (UTF-8، أسطر CRLF كي يعمل مع كل المحررين وFFmpeg) */
export function cuesToSrt(cues: Array<{ start: number; end: number; text: string }>): string {
  return (
    cues
      .map((c, i) => `${i + 1}\r\n${srtTime(c.start)} --> ${srtTime(Math.max(c.end, c.start + 0.3))}\r\n${c.text}\r\n`)
      .join("\r\n") + "\r\n"
  );
}

/** اختصار: توقيتات → SRT جاهز للرفع */
export function buildSrt(words: WordTiming[]): string {
  return cuesToSrt(buildCues(words));
}
