/**
 * تشكيل الحروف العربية للترجمة المحروقة (Arabic Contextual Shaping) — بلا أي تبعيات.
 *
 * المشكلة المُثبتة تجريبيًا (فحص إنتاج فعلي بتاريخ 2026-11-16):
 *   libass في ثنائي ffmpeg-static (بناء johnvansickle على Vercel) يملك FriBidi
 *   فيطبق إعادة ترتيب RTL للكلمات **بشكل صحيح**، لكن الحروف تظهر منفصلة
 *   (أشكال Isolated) لأن الخط الذي يجده fontconfig وقت الرندر ليس الخط
 *   العربي المضمّن ولا يملك جداول تشكيل GSUB — فيرسم كل حرف بمعزوله.
 *
 * الحل على طبقتين:
 *   1) fontsdir في فلتر subtitles (في videocut.js) — يجعل libass يجد
 *      Noto Sans Arabic المضمّن مباشرة فيطبق HarfBuzz التشكيل الكامل.
 *   2) هذه الوحدة «تحصين احتياطي»: نشكّل الحروف بأنفسنا إلى أشكال العرض
 *      (U+FE70–FEFF / U+FB50–FDFF) قبل كتابة ملف SRT — فحتى لو وقع الرندر
 *      على خطٍ ساقط لا يملك GSUB لكنه يملك أشكال العرض (مثل DejaVu)،
 *      تُقرأ الأشكال المسبقة من cmap مباشرة فيظهر النص متصلًا.
 *
 * قرار مهم — إعادة ترتيب RTL:
 *   كل بناء libass يتضمن fribidi إلزاميًا (اعتماد صلب منذ الأصل)، وقد أثبت
 *   الفحص الإنتاجي أن الترتيب البصري للكلمات صحيح أصلًا على Vercel. لو طبقنا
 *   عكسًا يدويًا فوق fribidi لانعكس الترتيب مرتين وفُسدت الأسطر المختلطة
 *   (عربي + أرقام/إنجليزية) لأن كشف اتجاه الفقرة عند fribidi يتغير. لذلك:
 *     - shapeArabicLine (الاتصال فقط) آمنة دائمًا وتُطبق افتراضيًا.
 *     - reorderRtlVisual (العكس الكامل) متاحة للبيئات الخالية من fribidi
 *       فقط، عبر متغير البيئة CAPTIONS_ARABIC_REORDER=1 — لا تفعّلها مع libass.
 *
 * إيقاف التشكيل الاحتياطي كليًا: CAPTIONS_ARABIC_PRESHAPE=0
 */

'use strict';

// ---------------------------------------------------------------------------
// جدول أشكال العرض العربية — [معزول Isolated, نهائي Final, أولي Initial, وسطي Medial]
// المصدر: Arabic Presentation Forms-A/B (U+FB50–FDFF / U+FE70–FEFF).
// طول المصفوفة يحدد نوع الوصل: 4=ثنائي الوصل D، 2=وصل يميني R، 1=غير واصل U.

const ARABIC_FORMS = {
  '\u0621': [0xFE80],                                          // ء همزة
  '\u0622': [0xFE81, 0xFE82],                                  // آ ألف مدّة
  '\u0623': [0xFE83, 0xFE84],                                  // أ ألف همزة فوق
  '\u0624': [0xFE85, 0xFE86],                                  // ؤ واو همزة
  '\u0625': [0xFE87, 0xFE88],                                  // إ ألف همزة تحت
  '\u0626': [0xFE89, 0xFE8A, 0xFE8B, 0xFE8C],                  // ئ ياء همزة
  '\u0627': [0xFE8D, 0xFE8E],                                  // ا ألف
  '\u0628': [0xFE8F, 0xFE90, 0xFE91, 0xFE92],                  // ب باء
  '\u0629': [0xFE93, 0xFE94],                                  // ة تاء مربوطة
  '\u062A': [0xFE95, 0xFE96, 0xFE97, 0xFE98],                  // ت تاء
  '\u062B': [0xFE99, 0xFE9A, 0xFE9B, 0xFE9C],                  // ث ثاء
  '\u062C': [0xFE9D, 0xFE9E, 0xFE9F, 0xFEA0],                  // ج جيم
  '\u062D': [0xFEA1, 0xFEA2, 0xFEA3, 0xFEA4],                  // ح حاء
  '\u062E': [0xFEA5, 0xFEA6, 0xFEA7, 0xFEA8],                  // خ خاء
  '\u062F': [0xFEA9, 0xFEAA],                                  // د dal
  '\u0630': [0xFEAB, 0xFEAC],                                  // ذ thal
  '\u0631': [0xFEAD, 0xFEAE],                                  // ر reh
  '\u0632': [0xFEAF, 0xFEB0],                                  // ز zain
  '\u0633': [0xFEB1, 0xFEB2, 0xFEB3, 0xFEB4],                  // س سين
  '\u0634': [0xFEB5, 0xFEB6, 0xFEB7, 0xFEB8],                  // ش شين
  '\u0635': [0xFEB9, 0xFEBA, 0xFEBB, 0xFEBC],                  // ص صاد
  '\u0636': [0xFEBD, 0xFEBE, 0xFEBF, 0xFEC0],                  // ض ضاد
  '\u0637': [0xFEC1, 0xFEC2, 0xFEC3, 0xFEC4],                  // ط طاء
  '\u0638': [0xFEC5, 0xFEC6, 0xFEC7, 0xFEC8],                  // ظ ظاء
  '\u0639': [0xFEC9, 0xFECA, 0xFECB, 0xFECC],                  // ع عين
  '\u063A': [0xFECD, 0xFECE, 0xFECF, 0xFED0],                  // غ غين
  '\u0641': [0xFED1, 0xFED2, 0xFED3, 0xFED4],                  // ف فاء
  '\u0642': [0xFED5, 0xFED6, 0xFED7, 0xFED8],                  // ق قاف
  '\u0643': [0xFED9, 0xFEDA, 0xFEDB, 0xFEDC],                  // ك كاف
  '\u0644': [0xFEDD, 0xFEDE, 0xFEDF, 0xFEE0],                  // ل لام
  '\u0645': [0xFEE1, 0xFEE2, 0xFEE3, 0xFEE4],                  // م ميم
  '\u0646': [0xFEE5, 0xFEE6, 0xFEE7, 0xFEE8],                  // ن نون
  '\u0647': [0xFEE9, 0xFEEA, 0xFEEB, 0xFEEC],                  // ه هاء
  '\u0648': [0xFEED, 0xFEEE],                                  // و واو
  '\u0649': [0xFEEF, 0xFEF0],                                  // ى ألف مقصورة
  '\u064A': [0xFEF1, 0xFEF2, 0xFEF3, 0xFEF4],                  // ي ياء
  '\u0640': [0x0640, 0x0640, 0x0640, 0x0640],                  // ـ تطويل — واصل ثنائي
  // حروف ممتدة (فارسي/أردو) لتغطية أوسع
  '\u0671': [0xFB50, 0xFB51],                                  // ٱ ألف وصلة
  '\u0679': [0xFB66, 0xFB67, 0xFB68, 0xFB69],                  // ٹ
  '\u067A': [0xFB6A, 0xFB6B, 0xFB6C, 0xFB6D],                  // ٺ
  '\u067E': [0xFB56, 0xFB57, 0xFB58, 0xFB59],                  // پ
  '\u0686': [0xFB7A, 0xFB7B, 0xFB7C, 0xFB7D],                  // چ
  '\u0688': [0xFB88, 0xFB89],                                  // ڈ
  '\u0691': [0xFB8C, 0xFB8D],                                  // ڑ
  '\u0698': [0xFB8A, 0xFB8B],                                  // ژ
  '\u06A9': [0xFB8E, 0xFB8F, 0xFB90, 0xFB91],                  // ک
  '\u06AF': [0xFB92, 0xFB93, 0xFB94, 0xFB95],                  // گ
  '\u06BA': [0xFB9E, 0xFB9F],                                  // ں
  '\u06C1': [0xFBA6, 0xFBA7, 0xFBA8, 0xFBA9],                  // ہ هاء هدف
  '\u06D2': [0xFBAE, 0xFBAF],                                  // ے
  '\u06CC': [0xFBFC, 0xFBFD, 0xFBFE, 0xFBFF],                  // ی ياء فارسية
};

/** ليغاتورات لام-ألف الإلزامية: [معزولة Isolated, نهائية Final] */
const LAM_ALEF = {
  '\u0622': [0xFEF5, 0xFEF6], // لآ
  '\u0623': [0xFEF7, 0xFEF8], // لأ
  '\u0625': [0xFEF9, 0xFEFA], // لإ
  '\u0627': [0xFEFB, 0xFEFC], // لا
};

/** أنواع الوصل محسوبة من طول مصفوفة الأشكال — تُبنى مرة عند التحميل */
const JOINING_TYPE = {};
for (const [ch, forms] of Object.entries(ARABIC_FORMS)) {
  JOINING_TYPE[ch] = forms.length === 4 ? 'D' : forms.length === 2 ? 'R' : 'U';
}

/** حروف شفافة لا تؤثر على الوصل (تشكيل وعلامات) — تتجاوزها سياقات الاتصال */
function isTransparentChar(cp) {
  return (
    (cp >= 0x0610 && cp <= 0x061A) || // علامات الإجازة
    (cp >= 0x064B && cp <= 0x065F) || // الحركات والتنوين والتشديد
    cp === 0x0670 ||                  // ألف خنجرية صغيرة
    (cp >= 0x06D6 && cp <= 0x06ED) || // علامات قرآنية
    cp === 0x200D                     // ZWJ — يوصل ما قبله وما بعده
  );
}

/** هل السطر يحتوي حرفًا عربيًا واصلًا أصلًا؟ (غير الحركات والأرقام) */
const ARABIC_LETTER_RE = /[\u0621-\u063A\u0641-\u064A\u0640\u0671-\u06D3\uFB50-\uFDFF\uFE70-\uFEFF]/;

// ---------------------------------------------------------------------------
// التشكيل السياقي — استبدال كل حرف بشكله المناسب حسب جيرانه

/** هل يتصل الحرف عند الموضع i بما قبله؟ (الحرف قبل النوع D يوصل لما بعده) */
function connectsFromPrev(chars, i) {
  for (let j = i - 1; j >= 0; j--) {
    const cp = chars[j].codePointAt(0);
    if (isTransparentChar(cp)) continue;
    const t = JOINING_TYPE[chars[j]];
    return t === 'D'; // ثنائي الوصل فقط يوصل إلى ما بعده
  }
  return false;
}

/** هل يتصل الحرف الحالي (ثنائي الوصل) بما بعده؟ */
function connectsToNext(chars, i) {
  const cur = JOINING_TYPE[chars[i]];
  if (cur !== 'D') return false; // R يوصل لما قبله فقط، U لا يوصل إطلاقًا
  for (let j = i + 1; j < chars.length; j++) {
    const cp = chars[j].codePointAt(0);
    if (isTransparentChar(cp)) continue;
    const t = JOINING_TYPE[chars[j]];
    return t === 'D' || t === 'R'; // ما بعده يقبل الوصل من جهة يمينه
  }
  return false;
}

/**
 * تطبيق الاتصال السياقي على سلسلة — يبدل كل حرف عربي بشكله
 * (Initial/Medial/Final/Isolated) ويشكّل ليغاتورات لام-ألف الإلزامية.
 * الحركات تُحفظ مواضعها وتتجاوزها السياقات.
 */
function shapeArabicLetters(s) {
  if (!ARABIC_LETTER_RE.test(s)) return s;
  const chars = Array.from(s);
  const out = [];
  const n = chars.length;
  for (let i = 0; i < n; i++) {
    const ch = chars[i];
    if (ch === '\u0644') {
      // لام-ألف: امسح ما بعد اللام متجاوزًا الشفاف بحثًا عن ألف
      let j = i + 1;
      const pendingMarks = [];
      while (j < n && isTransparentChar(chars[j].codePointAt(0))) {
        pendingMarks.push(chars[j]);
        j++;
      }
      if (j < n && LAM_ALEF[chars[j]]) {
        const lig = LAM_ALEF[chars[j]][connectsFromPrev(chars, i) ? 1 : 0];
        out.push(String.fromCodePoint(lig));
        for (const m of pendingMarks) out.push(m); // الحركات فوق الليغاتور
        i = j; // الألف استُهلكت داخل الليغاتور (والحلقة تزيد i فتتجاوزها)
        continue;
      }
    }
    const forms = ARABIC_FORMS[ch];
    if (!forms) {
      out.push(ch);
      continue;
    }
    const type = JOINING_TYPE[ch];
    let idx = 0; // معزول افتراضيًا
    if (type === 'D') {
      const prev = connectsFromPrev(chars, i);
      const next = connectsToNext(chars, i);
      if (prev && next) idx = 3;       // وسطي
      else if (prev) idx = 1;          // نهائي
      else if (next) idx = 2;          // أولي
    } else if (type === 'R') {
      if (connectsFromPrev(chars, i)) idx = 1; // نهائي فقط
    }
    out.push(String.fromCodePoint(forms[idx]));
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// إعادة الترتيب البصري RTL — فقط للبيئات الخالية من fribidi (انظر التعريف أعلاه)

/** انعكاس أقواس RTL — تُعكس عند العكس داخل مقاطع RTL */
const MIRROR = {
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{',
  '<': '>', '>': '<', '«': '»', '»': '«', '‹': '›', '›': '‹',
};

/** تصنيف اتجاه الحرف: R عربي، L لاتيني/أرقام، N محايد */
function bidiClass(cp) {
  if (
    (cp >= 0x0621 && cp <= 0x063A) || (cp >= 0x0641 && cp <= 0x064A) ||
    cp === 0x0640 || (cp >= 0x0671 && cp <= 0x06D3) ||
    (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF) ||
    cp === 0x060C || cp === 0x061B || cp === 0x061F || cp === 0x06D4 || // ، ؛ ؟ ۔
    cp === 0x200F // RLM
  ) return 'R';
  if (
    (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) ||
    (cp >= 0xC0 && cp <= 0x24F && cp !== 0xD7 && cp !== 0xF7) ||
    (cp >= 0x30 && cp <= 0x39) ||            // أرقام غربية
    (cp >= 0x0660 && cp <= 0x0669) ||        // أرقام عربية-هندية — تجري LTR
    (cp >= 0x06F0 && cp <= 0x06F9) ||
    cp === 0x200E // LRM
  ) return 'L';
  return 'N';
}

/**
 * عكس ترتيب مقاطع النص لعرض LTR مع اتجاه فقرة RTL (محاكاة مبسطة لخوارزمية BiDi):
 *   - المقاطع العربية تُعكس أحرفها (مع الحفاظ على الحركة ملاصقة لحرفها).
 *   - الأقواس داخل المقاطع العربية تُنعكس.
 *   - الكلمات اللاتينية والأرقام تبقى بترتيبها الطبيعي.
 *   - المحايد (مسافات/ترقيم) يتبع جيرانه، وعند الاختلاف يتبع اتجاه الفقرة RTL.
 * لا تُستدعَ إلا للأسطر التي فيها عربية — السطر اللاتيني الخالص يعود كما هو.
 */
function reorderRtlVisual(line) {
  const chars = Array.from(line);
  // 1) تصنيف الحروف (الحركات تأخذ صنف ما قبلها)
  const cls = new Array(chars.length);
  let lastReal = 'N';
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0);
    if (isTransparentChar(cp)) {
      cls[i] = lastReal; // الحركة تابعة لحرفها
      continue;
    }
    lastReal = bidiClass(cp);
    cls[i] = lastReal;
  }
  // 2) مقاطع متتالية من نفس الصنف (المحايد مقاطع مستقلة لحلها لاحقًا)
  const segs = [];
  for (let i = 0; i < chars.length; i++) {
    const c = cls[i];
    if (segs.length && segs[segs.length - 1].cls === c && c !== 'N') {
      segs[segs.length - 1].end = i + 1;
    } else {
      segs.push({ cls: c, start: i, end: i + 1 });
    }
  }
  // 3) حل المقاطع المحايدة حسب جيرانيها
  for (let k = 0; k < segs.length; k++) {
    if (segs[k].cls !== 'N') continue;
    const prev = segs[k - 1] && segs[k - 1].cls !== 'N' ? segs[k - 1].cls : null;
    const next = segs[k + 1] && segs[k + 1].cls !== 'N' ? segs[k + 1].cls : null;
    segs[k].cls = prev && next && prev === next ? prev : 'R'; // RTL اتجاه الفقرة
  }
  // 4) دمج المتجاورة المتشابهة ثم العكس
  const merged = [];
  for (const seg of segs) {
    const last = merged[merged.length - 1];
    if (last && last.cls === seg.cls) last.end = seg.end;
    else merged.push({ ...seg });
  }
  const out = [];
  for (let k = merged.length - 1; k >= 0; k--) {
    const seg = merged[k];
    const slice = chars.slice(seg.start, seg.end);
    if (seg.cls !== 'R') {
      out.push(...slice); // لاتيني/أرقام بترتيبها
      continue;
    }
    // عكس مقطع عربي معًا كوحدات: [حرف + حركاته] لا تنفصل
    const units = [];
    for (const ch of slice) {
      if (isTransparentChar(ch.codePointAt(0)) && units.length) {
        units[units.length - 1].push(ch);
      } else {
        units.push([ch]);
      }
    }
    for (let u = units.length - 1; u >= 0; u--) {
      for (const ch of units[u]) out.push(MIRROR[ch] || ch);
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// واجهات عليا — سطر وملف SRT

/**
 * تشكيل سطر ترجمة واحد:
 *  - بلا حروف عربية → كما هو (لاتيني خالص لا يُمس).
 *  - مع العربية → تشكيل سياقي، وإذا فُعّل CAPTIONS_ARABIC_REORDER=1
 *    يُضاف العكس البصري (لبيئات بلا fribidi فقط).
 */
function shapeArabicLine(line) {
  if (!ARABIC_LETTER_RE.test(line)) return line;
  let shaped = shapeArabicLetters(line);
  if (process.env.CAPTIONS_ARABIC_REORDER === '1') {
    shaped = reorderRtlVisual(shaped);
  }
  return shaped;
}

/**
 * تشكيل محتوى ملف SRT كامل: أسطر النص فقط — أرقام التسلسل وسطور التوقيت
 * والأسطر الفارغة تُترك كما هي تمامًا. يعيد الملف الأصلي إن لم يتغير شيء.
 */
function shapeSrt(srt) {
  if (typeof srt !== 'string' || !srt.includes('-->')) return srt;
  const eol = srt.includes('\r\n') ? '\r\n' : '\n';
  const lines = srt.split(/\r?\n/);
  let changed = false;
  const out = lines.map((line) => {
    const t = line.trim();
    if (!t) return line;                    // فاصل بين المقاطع
    if (/^\d+$/.test(t)) return line;       // رقم التسلسل
    if (t.includes('-->')) return line;     // سطر التوقيت
    const shaped = shapeArabicLine(line);
    if (shaped !== line) changed = true;
    return shaped;
  });
  return changed ? out.join(eol) : srt;
}

/** هل التشكيل الاحتياطي مفعّل؟ (افتراضيًا نعم — يُوقف بـ CAPTIONS_ARABIC_PRESHAPE=0) */
function preshapeEnabled() {
  const v = String(process.env.CAPTIONS_ARABIC_PRESHAPE || '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

module.exports = {
  ARABIC_FORMS,
  LAM_ALEF,
  shapeArabicLetters,
  shapeArabicLine,
  shapeSrt,
  reorderRtlVisual,
  preshapeEnabled,
};
