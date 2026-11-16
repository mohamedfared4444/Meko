# الخطوط المضمّنة للترجمة المتزامنة

## NotoSansArabic-Regular.ttf

- العائلة: **Noto Sans Arabic** (العربية بأشكال اتصال كاملة عبر GSUB + أرقام وترقيم
  أساسي — **بلا حروف A-Z/a-z لاتينية**)
- المصدر: <https://github.com/notofonts/arabic> (نسخة hinted ttf)
- الترخيص: **SIL Open Font License 1.1** — مسموح التضمين والاستخدام والتوزيع
  داخل الخدمة والأعمال المشتقة. النص الكامل للترخيص:
  <https://openfontlicense.org/>
- الاستخدام: يطبع FFmpeg (libass + fribidi) نص الترجمة المتزامنة على الفيديو
  النهائي عند تمرير `captions_url` إلى `POST /api/videocut` — الخط يُمرر لـ
  libass عبر «fontsdir» مباشرة + ملف fontconfig مؤقت يُنشأ داخل `lib/videocut.js`
  كطبقة ثانية، بلا أي اعتماد على خطوط نظام الاستضافة (Vercel serverless).

## LiberationSans-Regular.ttf

- العائلة: **Liberation Sans** (تغطية لاتينية كاملة A-Z/a-z)
- المصدر: <https://github.com/liberationfonts/liberation-fonts> (نسخة 2.1.5)
- الترخيص: **SIL Open Font License 1.1**
- سبب التضمين: بيئة lambda على Vercel بلا أي خط لاتيني، وخط Noto Sans Arabic
  لا يحتوي حروفًا لاتينية إطلاقًا — بدون هذا الخط تظهر الكلمات الإنجليزية
  في الترجمة مربعات tofu. libass يسقط عليه تلقائيًا للحروف التي يفتقدها
  الخط الأساسي (per-glyph fallback عبر fontconfig).

