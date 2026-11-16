# الخطوط المضمّنة للترجمة المتزامنة

## NotoSansArabic-Regular.ttf

- العائلة: **Noto Sans Arabic** (تدعم العربية + الأحرف اللاتينية الأساسية)
- المصدر: <https://github.com/notofonts/arabic> (نسخة hinted ttf)
- الترخيص: **SIL Open Font License 1.1** — مسموح التضمين والاستخدام والتوزيع
  داخل الخدمة والأعمال المشتقة. النص الكامل للترخيص:
  <https://openfontlicense.org/>
- الاستخدام: يطبع FFmpeg (libass + fribidi) نص الترجمة المتزامنة على الفيديو
  النهائي عند تمرير `captions_url` إلى `POST /api/videocut` — ملف
  fontconfig مؤقت يُنشأ داخل `lib/videocut.js` ليجعل هذا الخط مرئيًا
  لـ libass بلا اعتماد على خطوط نظام الاستضافة (Vercel serverless).
