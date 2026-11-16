/**
 * اختبارات وحدة التشكيل العربي — node scripts/test-arabic-text.js
 * تتحقق من: الليغاتورات، السياقات (أولي/وسطي/نهائي/معزول)، الحركات الشفافة،
 * التطويل، العودة للخلف (unshape)، idempotency، ملف SRT، والعكس البصري.
 */

const path = require('path');
const {
  ARABIC_FORMS, LAM_ALEF, shapeArabicLetters, shapeArabicLine,
  shapeSrt, reorderRtlVisual, preshapeEnabled,
} = require(path.join(__dirname, '..', 'lib', 'arabic-text.js'));

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  if (got === want) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}\n      المتوقع: ${cp(want)}\n      الناتج : ${cp(got)}`);
  }
}
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}
function cp(s) {
  return Array.from(String(s)).map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
}

// خريطة عكسية للتحقق من الاسترجاع
const REV = {};
for (const [base, forms] of Object.entries(ARABIC_FORMS)) {
  for (const f of forms) REV[f] = base;
}
for (const [alef, iso_fin] of Object.entries(LAM_ALEF)) {
  REV[iso_fin[0]] = '\u0644' + alef;
  REV[iso_fin[1]] = '\u0644' + alef;
}
function unshape(s) {
  return Array.from(s).map((c) => REV[c.codePointAt(0)] || c).join('');
}

console.log('\n— ليغاتور لام-ألف —');
eq('لا → FEFB', shapeArabicLetters('لا'), '\uFEFB');
eq('بلا → باء أولية + لا نهائية', shapeArabicLetters('بلا'), '\uFE91\uFEFC');
eq('لأ معزولة', shapeArabicLetters('لأ'), '\uFEF7');
eq('بلإ → باء أولية + لإ نهائية', shapeArabicLetters('بلإ'), '\uFE91\uFEFA');
eq('بلآ → باء أولية + لآ نهائية', shapeArabicLetters('بلآ'), '\uFE91\uFEF6');
eq('للا → لام أولية + لا نهائية', shapeArabicLetters('للا'), '\uFEDF\uFEFC');

console.log('\n— سياقات الاتصال —');
eq('اب → ألف معزولة + باء معزولة', shapeArabicLetters('اب'), '\uFE8D\uFE8F');
eq('با → باء أولية + ألف نهائية', shapeArabicLetters('با'), '\uFE91\uFE8E');
eq('بب → باء أولية + باء نهائية', shapeArabicLetters('بب'), '\uFE91\uFE90');
eq('باب → أولية + ألف نهائية + باء معزولة (الألف لا توصل لما بعدها)', shapeArabicLetters('باب'), '\uFE91\uFE8E\uFE8F');
eq('كتب → كاف أولية + تاء وسطية + باء نهائية', shapeArabicLetters('كتب'), '\uFEDB\uFE98\uFE90');
eq('اكتب → ألف معزولة + كاف أولية + تاء وسطية + باء نهائية', shapeArabicLetters('اكتب'), '\uFE8D\uFEDB\uFE98\uFE90');
eq('مد → ميم أولية + dal نهائية', shapeArabicLetters('مد'), '\uFEE3\uFEAA');

console.log('\n— الحركات الشفافة —');
eq('بَا مع فتحة بين الحرفين', shapeArabicLetters('بَا'), '\uFE91\u064E\uFE8E');
eq('مَدِينَة بحركات: ميم أولية + dal نهائية + ياء أولية + نون وسطية + ة نهائية', shapeArabicLetters('مَدِينَة'), '\uFEE3\u064E\uFEAA\u0650\uFEF3\uFEE8\u064E\uFE94');

console.log('\n— التطويل —');
eq('دـر → dal معزولة + تطويل + راء نهائية', shapeArabicLetters('دـر'), '\uFEA9\u0640\uFEAE');

console.log('\n— اللاتيني يمر كما هو —');
eq('Hello 123', shapeArabicLetters('Hello 123'), 'Hello 123');
eq('سطر بلا عربية يمر كما هو', shapeArabicLine('Hello world!'), 'Hello world!');

console.log('\n— استرجاع كامل (unshape∘shape = identity) —');
const samples = [
  'مكتبة الإسكندرية القديمة',
  'نص عربي مع English 2025',
  'في عام 2025 قرأت 3 كتب',
  'لا بأٍ لآ لإ لكلمات',
  'انتهى الفيديو.',
];
for (const s of samples) {
  eq(`roundtrip: ${s}`, unshape(shapeArabicLetters(s)), s);
}

console.log('\n— idempotency (تشكيل نص مشكّل لا يغيّره) —');
const once = shapeArabicLetters('مكتبة الإسكندرية');
eq('تشكيل مرتين = مرة واحدة', shapeArabicLetters(once), once);

console.log('\n— ملف SRT —');
const srtIn = '1\r\n00:00:00,500 --> 00:00:03,400\r\nمكتبة الإسكندرية القديمة\r\n\r\n2\r\n00:00:03,500 --> 00:00:06,400\r\nHello world\r\n\r\n';
const srtOut = shapeSrt(srtIn);
ok('يحتفظ بـ CRLF', srtOut.includes('\r\n'));
ok('التوقيتات سليمة', srtOut.includes('00:00:00,500 --> 00:00:03,400') && srtOut.includes('00:00:03,500 --> 00:00:06,400'));
ok('أرقام التسلسل سليمة', srtOut.split('\r\n').includes('1') && srtOut.split('\r\n').includes('2'));
ok('السطر العربي تغيّر', srtOut.includes(shapeArabicLetters('مكتبة الإسكندرية القديمة')));
ok('السطر اللاتيني لم يتغير', srtOut.includes('Hello world'));
eq('تشكيل ملف مُشكَّل = لا تغيير', shapeSrt(srtOut), srtOut);
eq('غير SRT يمر كما هو', shapeSrt('نص عادي'), 'نص عادي');

console.log('\n— العكس البصري (لبيئات بلا fribidi فقط) —');
const r1 = reorderRtlVisual(shapeArabicLetters('مكتبة'));
// مكتبة مشكّلة = ميم أولية كاف وسطية تاء وسطية باء وسطية ة نهائية — العكس يبدأ بالة
ok('عكس سطر عربي خالص يعكس الحروف', Array.from(r1)[0] === '\uFE94' && Array.from(r1).length === 5, cp(r1));
const r2 = reorderRtlVisual(shapeArabicLetters('عربي 123'));
ok('الأرقام تبقى LTR داخل العكس', r2.includes('123'), cp(r2));
eq('سطر لاتيني خالص لا يتغير', reorderRtlVisual('Hello 123'), 'Hello 123');
const r4 = reorderRtlVisual(shapeArabicLetters('قرأت 3 كتب'));
ok('الأرقام محفوظة والمقاطع معكوسة', r4.includes('3') && !r4.startsWith('ق'), cp(r4));
const r5 = reorderRtlVisual(shapeArabicLetters('النص (ملاحظة) هنا'));
ok('الأقواس تُنعكس داخل مقطع عربي', r5.includes('(') && r5.includes(')'), cp(r5));

console.log('\n— مفتاح التفعيل —');
eq('افتراضي مفعّل', preshapeEnabled(), true);
process.env.CAPTIONS_ARABIC_PRESHAPE = '0';
eq('CAPTIONS_ARABIC_PRESHAPE=0 يعطّل', preshapeEnabled(), false);
delete process.env.CAPTIONS_ARABIC_PRESHAPE;
process.env.CAPTIONS_ARABIC_REORDER = '1';
ok('REORDER=1 يضيف العكس للسطر العربي', shapeArabicLine('مكتبة') === reorderRtlVisual(shapeArabicLetters('مكتبة')));
delete process.env.CAPTIONS_ARABIC_REORDER;
eq('بدون REORDER: تشكيل فقط', shapeArabicLine('مكتبة'), shapeArabicLetters('مكتبة'));

console.log(`\nالنتيجة: ${pass} نجاح، ${fail} فشل`);
process.exit(fail ? 1 : 0);
