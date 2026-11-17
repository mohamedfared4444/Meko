/**
 * اختبار منطق طبقة الترجمة الحركية الحقيقية من render-code-video.js
 * — يستخرج installCaptionsInPage من الملف ويشغّله بـ DOM وهمي، ويتحقق من:
 *   1) دمج اللاحقات ('s / n't / علامات الترقيم) بالكلمة السابقة
 *   2) المسافات الصريحة بين الكلمات في innerHTML
 *   3) مقاطع 2–3 كلمات كحد أقصى
 *   4) الحجم: 44px عند viewport 720 / 66px عند viewport 1080 (نسبة 6.1%)
 *   5) كشف RTL للعربية
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "render-code-video.js");
const src = fs.readFileSync(SRC, "utf8");

// استخراج دالة installCaptionsInPage بمطابقة الأقواس
const startMark = "function installCaptionsInPage(spec) {";
const start = src.indexOf(startMark);
if (start < 0) throw new Error("لم تُوجد installCaptionsInPage في الملف");
let depth = 0, end = -1;
for (let i = start + startMark.length - 1; i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) throw new Error("تعذر استخراج جسم الدالة (أقواس غير متوازنة)");
const funcSrc = src.slice(start, end);

// DOM وهمي
function makeEl(tag) {
  return {
    tagName: tag, id: "", attrs: {}, children: [],
    style: { setProperty(k, v) { this[`__${k}`] = v; }, display: "" },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); },
    textContent: "", innerHTML: "", dir: "",
  };
}
let els;
function freshDom(viewportW) {
  els = [];
  const body = makeEl("body"), head = makeEl("head");
  els.push(body, head);
  globalThis.document = {
    body, head,
    documentElement: { clientWidth: viewportW, clientHeight: Math.round(viewportW * 16 / 9), style: {} },
    getElementById: (id) => els.find((e) => e.id === id) || null,
    createElement: (tag) => { const el = makeEl(tag); els.push(el); return el; },
  };
  globalThis.window = {};
  return new Function("document", "window", `${funcSrc}\nreturn installCaptionsInPage;`)(globalThis.document, globalThis.window);
}

const spanRe = /<span class="meko-cap-w (\w+)" style="font-size:var\(--meko-cap-size,(\d+)px\)">([^<]+)<\/span>/g;
function spansOf(layer) {
  return [...layer.innerHTML.matchAll(spanRe)].map((m) => ({ cls: m[1], size: m[2], text: m[3] }));
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ===== الحالة 1: دمج اللاحقات + المسافات + الحجم عند 1080 =====
console.log("الحالة 1: viewport 1080 — دمج 's والنقطة + مسافات + مقاطع ≤3");
{
  const w = (t, s, e) => ({ text: t, start: s, end: e });
  const timings = [
    w("Here", 0, 0.4), w("'s", 0.4, 0.5), w("something", 0.5, 1.2), w("every", 1.2, 1.5),
    w("night", 1.5, 1.9), w("while", 1.9, 2.4), w("your", 2.4, 2.6),
    w("crew", 2.6, 2.9), w("the", 2.9, 3.1), w("brain", 3.1, 3.6), w(".", 3.6, 3.7),
  ];
  freshDom(1080);
  const fn = new Function("document", "window", `${funcSrc}\nreturn installCaptionsInPage;`)(globalThis.document, globalThis.window);
  const installed = fn({ targetW: 1080, targetH: 1920, timings });
  const layer = els.find((e) => e.id === "meko-captions");
  check("التركيب نجح", installed === true);
  check("الحجم 66px عند viewport 1080", layer.style["__--meko-cap-size"] === "66px",
    `الفعلي ${layer.style["__--meko-cap-size"]}`);

  // لقطة أول مقطع (0.7s): Here's done + something on + every next
  globalThis.window.__mekoUpdateCaptions(0.7);
  const spans = spansOf(layer);
  check("المقطع الأول 3 كلمات", spans.length === 3, `الفعلي ${spans.length}`);
  check("الدمج Here's", spans[0] && spans[0].text === "Here's", spans[0] && spans[0].text);
  check("التمييز on للكلمة الجارية", spans[1] && spans[1].cls === "on", spans[1] && spans[1].cls);
  check("done للمنتهية", spans[0] && spans[0].cls === "done", spans[0] && spans[0].cls);
  check("next للقادمة", spans[2] && spans[2].cls === "next", spans[2] && spans[2].cls);
  check("مسافة صريحة بين الكلمات", /<\/span> <span /.test(layer.innerHTML));
  const between = layer.innerHTML.match(/<\/span>(\s*)<span /);
  check("مسافة واحدة بالضبط (بلا تصاق)", between && between[1] === " ", JSON.stringify(between && between[1]));

  // لقطة آخر مقطع (3.3s): crew + the + brain. — الدمج مع النقطة
  globalThis.window.__mekoUpdateCaptions(3.3);
  const spans2 = spansOf(layer);
  check("آخر مقطع 3 كلمات", spans2.length === 3, `الفعلي ${spans2.length}`);
  check("دمج النقطة مع brain", spans2[2] && spans2[2].text === "brain.", spans2[2] && spans2[2].text);

  // بين المقاطع: أخفاء
  globalThis.window.__mekoUpdateCaptions(3.75); // داخل نافذة آخر مقطع (end 3.7 + 0.45)
  check("عرض آخر مقطع حتى end+0.45", layer.style.display === "flex");
  globalThis.window.__mekoUpdateCaptions(4.5);
  check("الإخفاء بين المقاطع", layer.style.display === "none" && layer.innerHTML === "");

  // اتجاه LTR للإنجليزية
  globalThis.window.__mekoUpdateCaptions(0.7);
  check("اتجاه LTR للإنجليزية", layer.dir === "ltr");
}

// ===== الحالة 2: n't =====
console.log("الحالة 2: دمج n't");
{
  const fn = freshDom(1080);
  const installed = fn({ targetW: 1080, targetH: 1920, timings: [
    { text: "do", start: 0, end: 0.3 }, { text: "n't", start: 0.3, end: 0.5 }, { text: "stop", start: 0.5, end: 1 },
  ] });
  const layer = els.find((e) => e.id === "meko-captions");
  globalThis.window.__mekoUpdateCaptions(0.2);
  const spans = spansOf(layer);
  check("التركيب نجح", installed === true);
  check("don't كلمة واحدة مدموجة", spans[0] && spans[0].text === "don't", spans[0] && spans[0].text);
  check("المقطع = كلمتان", spans.length === 2, `الفعلي ${spans.length}`);
}

// ===== الحالة 3: RTL للعربية =====
console.log("الحالة 3: RTL للعربية");
{
  const fn = freshDom(1080);
  fn({ targetW: 1080, targetH: 1920, timings: [
    { text: "النوم", start: 0, end: 0.6 }, { text: "ينظف", start: 0.6, end: 1.1 }, { text: "الدماغ", start: 1.1, end: 1.6 },
  ] });
  const layer = els.find((e) => e.id === "meko-captions");
  globalThis.window.__mekoUpdateCaptions(0.2);
  check("اتجاه RTL للعربية", layer.dir === "rtl");
}

// ===== الحالة 4: viewport 720 (استراتيجية viewport-dsf) =====
console.log("الحالة 4: viewport 720 — الحجم 44px حرفيًا");
{
  // DOM جديد كليًا لمحاكاة إعادة التركيب بعد إعادة ضبط الـ viewport
  const fn = freshDom(720);
  const installed = fn({ targetW: 1080, targetH: 1920, timings: [
    { text: "hello", start: 0, end: 0.5 }, { text: "world", start: 0.5, end: 1 },
  ] });
  const layer = els.find((e) => e.id === "meko-captions");
  check("التركيب نجح", installed === true);
  check("الحجم 44px عند viewport 720", layer.style["__--meko-cap-size"] === "44px",
    `الفعلي ${layer.style["__--meko-cap-size"]}`);
  globalThis.window.__mekoUpdateCaptions(0.2);
  const spans = spansOf(layer);
  check("font-size في الـ span مطابق", spans[0] && spans[0].size === "44", spans[0] && spans[0].size);
}

// ===== الحالة 5: حد 3 كلمات مع تتابع سريع (بلا فجوات صمت) =====
console.log("الحالة 5: تقسيم 8 كلمات متتالية إلى 3+3+2");
{
  const fn = freshDom(1080);
  fn({ targetW: 1080, targetH: 1920, timings: [
    { text: "one", start: 0, end: 0.4 }, { text: "two", start: 0.4, end: 0.8 }, { text: "three", start: 0.8, end: 1.2 },
    { text: "four", start: 1.2, end: 1.6 }, { text: "five", start: 1.6, end: 2 }, { text: "six", start: 2, end: 2.4 },
    { text: "seven", start: 2.4, end: 2.8 }, { text: "eight", start: 2.8, end: 3.2 },
  ] });
  const layer = els.find((e) => e.id === "meko-captions");
  const counts = [];
  // نوافذ العرض متداخلة عمدًا (start-0.3 → end+0.45) — نختار أزمنة خارج
  // نافذة المقطع السابق كي نعرف عدّ كل مقطع بمفرده: 2.9 بعد نهاية نافذة الثاني (2.85)
  for (const t of [0.2, 1.4, 2.9]) {
    globalThis.window.__mekoUpdateCaptions(t);
    counts.push(spansOf(layer).length);
  }
  check("المقاطع 3/3/2", JSON.stringify(counts) === "[3,3,2]", JSON.stringify(counts));
}

// ===== الحالة 6: نمط single-pop عند viewport 1080 =====
console.log("الحالة 6: single-pop — كلمة واحدة، ذهبي للطويلة، نبضة scale، الحجم 78px");
{
  const popRe = /<span class="meko-cap-pop( gold)?" style="font-size:var\(--meko-cap-size,(\d+)px\);transform:scale\(([\d.]+)\)">([^<]+)<\/span>/;
  const fn = freshDom(1080);
  const installed = fn({
    targetW: 1080, targetH: 1920, captionStyle: "single-pop",
    timings: [
      { text: "Hi", start: 0, end: 0.5 },
      { text: "everyone", start: 0.5, end: 1.2 },
      { text: "look", start: 1.2, end: 1.6 },
      { text: "brain", start: 1.6, end: 2.2 },
      { text: "cleaning", start: 2.2, end: 3 },
    ],
  });
  const layer = els.find((e) => e.id === "meko-captions");
  const styleEl = els.find((e) => e.attrs && e.attrs["data-meko-captions"]);
  check("التركيب نجح", installed === true);
  check("الطبقة تحمل صنف pop", layer.className === "pop", layer.className);
  check("الموضع 74% في CSS", styleEl.textContent.includes("#meko-captions.pop{top:74%;}"));
  check("حدود سوداء + paint-order في CSS", styleEl.textContent.includes("-webkit-text-stroke:.0513em #0f172a;paint-order:stroke fill;"));
  check("الذهبي #FACC15 في CSS", styleEl.textContent.includes(".meko-cap-pop.gold{color:#FACC15;}"));
  check("وزن 900 في CSS", styleEl.textContent.includes(".meko-cap-pop{display:inline-block;font-weight:900;color:#FFFFFF;"));
  check("بلا صندوق خلفية في CSS", styleEl.textContent.includes("#meko-captions .meko-cap-pop{") && !/\.meko-cap-pop\{[^}]*background/.test(styleEl.textContent));
  check("صندوق phrase الزجاجي محفوظ للنمط الافتراضي", styleEl.textContent.includes("background:rgba(7,11,22,.62)"));
  check("الحجم 78px عند viewport 1080", layer.style["__--meko-cap-size"] === "78px", `الفعلي ${layer.style["__--meko-cap-size"]}`);

  // قبل أول كلمة: مخفي
  globalThis.window.__mekoUpdateCaptions(-0.5);
  check("الإخفاء قبل أول كلمة", layer.style.display === "none" && layer.innerHTML === "");
  // لحظة النطق: scale 1.12 + أبيض لكلمة قصيرة
  globalThis.window.__mekoUpdateCaptions(0);
  let m = layer.innerHTML.match(popRe);
  check("نبضة scale(1.12) لحظة البدء", m && m[3] === "1.1200", m && m[3]);
  check("كلمة قصيرة أبيض (بلا gold)", m && m[1] === undefined && m[4] === "Hi", m && `${m[1]}|${m[4]}`);
  // بعد 120ms: scale 1.0
  globalThis.window.__mekoUpdateCaptions(0.13);
  m = layer.innerHTML.match(popRe);
  check("العودة إلى scale(1.0) بعد 120ms", m && m[3] === "1.0000", m && m[3]);
  // كلمة طويلة: ذهبية
  globalThis.window.__mekoUpdateCaptions(0.7);
  m = layer.innerHTML.match(popRe);
  check("الطويلة (>5) ذهبية", m && m[1] === " gold" && m[4] === "everyone", m && `${m[1]}|${m[4]}`);
  // brain = 5 أحرف بالضبط → أبيض (حد >5)
  globalThis.window.__mekoUpdateCaptions(1.8);
  m = layer.innerHTML.match(popRe);
  check("5 أحرف بالضبط تبقى أبيض", m && m[1] === undefined && m[4] === "brain", m && `${m[1]}|${m[4]}`);
  // الكلمة تبقى ظاهرة حتى تبدأ التالية (حمل بعد نهايتها)
  globalThis.window.__mekoUpdateCaptions(2.25);
  m = layer.innerHTML.match(popRe);
  check("انتقال للكلمة التالية عند بدئها", m && m[4] === "cleaning" && m[1] === " gold", m && `${m[1]}|${m[4]}`);
  globalThis.window.__mekoUpdateCaptions(3.5);
  m = layer.innerHTML.match(popRe);
  check("الكلمة الأخيرة تبقى بعد انتهائها", m && m[4] === "cleaning");
  // كلمة واحدة فقط في كل إطار
  const count = (layer.innerHTML.match(/<span /g) || []).length;
  check("span واحد فقط في كل إطار", count === 1, `الفعلي ${count}`);
}

// ===== الحالة 7: single-pop عند viewport 720 (viewport-dsf) =====
console.log("الحالة 7: single-pop عند viewport 720 — 52px CSS = 78px فيزيائية");
{
  const fn = freshDom(720);
  const installed = fn({ targetW: 1080, targetH: 1920, captionStyle: "single-pop", timings: [
    { text: "hello", start: 0, end: 0.5 }, { text: "world", start: 0.5, end: 1 },
  ] });
  const layer = els.find((e) => e.id === "meko-captions");
  check("التركيب نجح", installed === true);
  check("الحجم 52px CSS عند viewport 720", layer.style["__--meko-cap-size"] === "52px", `الفعلي ${layer.style["__--meko-cap-size"]}`);
}

// ===== الحالة 8: phrase يبقى سليمًا (عدم انكسار النمط الافتراضي) =====
console.log("الحالة 8: phrase بلا caption_style — السلوك الافتراضي محفوظ");
{
  const fn = freshDom(1080);
  const installed = fn({ targetW: 1080, targetH: 1920, timings: [
    { text: "alpha", start: 0, end: 0.5 }, { text: "beta", start: 0.5, end: 1 }, { text: "gamma", start: 1, end: 1.5 },
  ] });
  const layer = els.find((e) => e.id === "meko-captions");
  check("التركيب نجح", installed === true);
  check("الطبقة بلا صنف pop", layer.className === "", layer.className);
  globalThis.window.__mekoUpdateCaptions(0.2);
  check("مقاطع phrase كما كانت", /<div class="meko-cap-line"><span class="meko-cap-w /.test(layer.innerHTML));
}

console.log(`\nالنتيجة: ${pass} ناجح، ${fail} فاشل`);
process.exit(fail ? 1 : 0);
