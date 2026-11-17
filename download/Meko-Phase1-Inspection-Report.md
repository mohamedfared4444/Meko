# تقرير الفحص الشامل — Meko (المرحلة الأولى)

التاريخ: 2026-11-18 — الفحص تم على الكود الفعلي والحالة الحية، لا على التقارير القديمة.

## 1) ما يعمل حاليًا بالفعل (مؤكد بالفحص الحي)

| المكوّن | الحالة | الدليل |
|---|---|---|
| Core (meko-nine.vercel.app) | يعمل | `/api/health`: `ok=true`, `turso-connected`, 3 نماذج |
| خدمة الدمج (meko-manger) | تعمل | `merger.healthy=true` في `/api/health` |
| بوابة الأتمتة `/api/automate/video` | تعمل ومحمية | مفتاح خاطئ → HTTP 401 (أي مفتاح `automation_key` مضبوط في Turso meta) |
| مصادقة البوابة | Bearer + `timingSafeEqual` | `src/app/api/automate/video/route.ts` سطور 54–89 |
| قاعدة Turso | متصلة | 63 مهمة (31 مكتملة، 32 فاشلة) |
| GitHub Actions worker | مطابق محليًا وعالميًا | `diff` بين `.github/workflows/…` ونسخة `meko-renderer/main`: متطابقان بايت ببايت |

## 2) مسار المهمة من الطلب حتى MP4 (مؤكد من الكود)

```
POST /api/automate/video  (Bearer automation_key)
  → تحقق مصادقة (env AUTOMATION_API_KEY أو meta.automation_key) + timingSafeEqual
  → zod schema (title/script/voice/html_code/caption_style/bg_music_url/webhook…)
  → runCodeVideo():
      insertTask في Turso فورًا (status=processing) — المهمة تظهر في اللوحة قبل أي عمل شبكي
      → ensureAudio: Edge-TTS (websocket) → MP3 + wordTimings من نفس النداء
         حراسة: صوت فارغ/مدة غير صالحة → فشل صريح (لا فيديو أخرس)
         → uploadViaHosts (tmpfiles → uguu → litterbox → catbox → 0x0 → data:)
      → ensureRender:
         توكن GitHub (env GH_RENDER_TOKEN/GITHUB_TOKEN أو meta.github_token)
         → mergerStoreRenderPayload (كود + صوت + توقيتات → render_payloads على meko-manger، TTL 24h)
         → dispatchRenderWorkflow (workflow_dispatch على mohamedfared4444/meko-renderer)
            مدخلات: task_id, job_id, payload_url, width/height/fps, duration, audio_url, bg_music_url
         احتياط بلا توكن: رندر سريع متزامن على meko-manger /api/codevideo
  → العامل (GitHub Actions ubuntu):
      loadPayload (GET /api/render-payload?id=…) → clampEven (أبعاد زوجية) → تنزيل الصوت
      → مدة الصوت هي المرجع → Chromium يرندر كل إطار بنداء renderAtTime(t, d, timings)
      → طبقة الترجمة الحركية (phrase | single-pop، RTL تلقائي + خطوط Noto Arabic)
      → ffmpeg libx264 yuv420p 30fps FHD
      → رفع مجزأ (op=chunk) → op=finalize → إنشاء jobs row → تحديث tasks
         status=completed, progress=100, video_url=/api/jobs/{job}/video
      → إطلاق webhook_callback_url (POST {task_id,status,video_url,title})
      احتياطات: إصدار GitHub → Turso مباشرة (--fail يفشل المهمة عند أي فشل سابق)
  → الاستعلام: GET /api/automate/video?task_id=… (Bearer) أو webhook أو لوحة التحكم
```

## 3) انتقال البيانات بين الأجزاء

- **Core → Manager**: `MERGER_API_BASE` — تخزين الحمولة (POST /api/render-payload) ورفع الأجزاء من العامل.
- **Core → GitHub**: `workflow_dispatch` عبر REST API بتوكن بصلاحية repo/workflow. المدخلات ≤ ~64KB؛ الحمولة الكبيرة عبر `payload_url`.
- **Worker → Manager**: chunks ثنائية ≤2.5MB ثم finalize JSON. حماية "معرفة القدرة": `job_id` يجب أن يطابق `ghJobId/videoJobId` المسجلين على المهمة وقت الإطلاق.
- **Manager → Turso**: نفس قاعدة Meko المشتركة (تحديث الحالة مباشرة من finalize).
- **Worker → Turso**: مسار احتياط أخير فقط (أسرار TURSO في secrets الـ workflow).

## 4) الصوت والتوقيتات

Edge-TTS عبر websocket (`msedge-tts`) بصيغة MP3 24kHz/48kbit — `collectTimings: true` يستخرج `wordTimings` ({start,end,text}) من metadata نفس النداء، وتُمرر إلى `renderAtTime` في كل إطار. المدة = مدة الصوت الفعلية. السرعة الافتراضية -7%.

## 5) ما لا يعمل أو يحتاج إصلاحًا (مؤكد فعليًا)

1. **`/api/keys` (GET/POST) و `/api/keys/[id]` (PATCH/DELETE): بلا أي مصادقة** — إثبات حي: GET بلا ترويسة أعاد HTTP 200 مع 7 مفاتيح (مقنّعة القيم لكن metadata + إحصاءات الاستخدام + provider مكشوفة لأي غريب).
2. **`/api/tasks` (GET/POST) و `/api/tasks/create` و `/api/tasks/rerender`: بلا أي مصادقة** — إثبات حي: GET بلا ترويسة أعاد 990KB بيانات (63 مهمة، prompts، روابط). وأي غريب يستطيع إنشاء مهام (يحرق دقائق Actions وEdge-TTS) أو إعادة رندر.
3. **`/mcp` مفتوح**: `MCP_ACCESS_TOKEN` غير مضبوط في Vercel (`authRequired: false` حيًا) — أي غريب يستدعي أدوات MCP بما فيها render_code_video.
4. **سر مكتوب في الكود المتتبع**: نقاط الصيانة `maintenance/pipeline` و`maintenance/dbfix` تحمل المفتاح نصًا في السطر (`secret !== "0f4c…"`) — مكشوف في المستودع.
5. **`.env` متتبع في Git** (commit `03cef5d` في التاريخ). المحتوى الحالي: `DATABASE_URL=file:…` محلي بلا أي توكن — الخطورة منخفضة لكنه مخالف للممارسة الآمنة.
6. **اختبارات الترجمة الـ45 معطلة**: `scripts/test_captions_logic.js` يقرأ `renderer-repo/scripts/render-code-video.js` وهذا الدليل لم يعد موجودًا (النسخة الموحدة الآن في `scripts/render-code-video.js` داخل Meko نفسه).
7. **البنية تغيرت عن التقرير السابق**: `renderer-repo/` حُذف من القرص، وملفات العامل (workflow + script) أصبحت متتبعة داخل Meko نفسه (`.github/workflows/render-code-video.yml` + `scripts/render-code-video.js`) — ومتطابقة بايت-ببايت مع المستودع العام.

## 6) الأسرار — نتائج المسح (بدون أي قيم)

| البحث | النتيجة |
|---|---|
| ملفات env متتبعة | `.env` (رابط file: محلي فقط)، `.env.example` (placeholders فارغة)، `merger/.env.example` |
| `TURSO_AUTH_TOKEN=` في التاريخ | فقط في `.env.example` بقيم **فارغة** — لا توكن حقيقي |
| `ghp_` في التاريخ | نص توثيقي فقط في تعليق `merger/api/meta.js` — ليس توكنًا |
| مفتاح الأتمتة (`mkau…`) | **غير موجود** في أي ملف متتبع ولا في تاريخ Git — يُقرأ وقت التشغيل من `.automation-key` غير المتتبع أو Turso meta |
| `DATABASE_URL=` في `.env` المتتبع | رابط `file:` محلي 36 حرفًا، بلا authToken — لا سر حقيقي |
| توكن GitHub في remote URL | مضمّن في `origin` محليًا (طريقة الدفع المعتمدة) — لا يظهر في أي ملف متتبع |

**الخلاصة**: لا يوجد سر حقيقي مكشوف في تاريخ Git يستوجب تدوير Turso فورًا. المطلوب: إزالة `.env` من التتبع + نظافة الـ gitignore، وتدوير مفتاح الأتمتة وفق سير العمل المتبع (يُخزَّن في `.automation-key` غير المتتبع) لتأمين اختبارات الدخول الإيجابية.

## 7) نقاط الفشل المحتملة (موجودة في التصميم — معالجاتها قائمة)

- ميزانية Vercel 60s: آلة حالات قابلة للاستكمال + حفظ كل خطوة في params_json.
- مهام عالقة: مهلة 10 دقائق تلقائية في GET /api/tasks (مستثناة للمهام المطلقة على GH بحارس 40 دقيقة).
- رندر بلا صوت: رفض صريح للصوت الفارغ/المدة غير الصالحة.
- فشل الرفع للدمج: إصدار GitHub ثم Turso مباشرة.
- تكرار الإطلاق: `renderDispatched` + `ghJobId` ثابتان، وrerender يرفض المهام processing.
- تنظيف: cron يومي يحذف الحمولات والمهام المنتهية (24h).
- التقدم الحي غير الحرج: pingProgress يبتلع الفشل.

## 8) قرارات التصميم الحالية التي تُركت كما هي (وثّقت كمخاطر متبقية)

- نقاط meko-manger (jobs/upload/codevideo/render-payload GET) بلا مصادقة — تصميم "معرفة القدرة" UUID؛ العامل يقرأ الحمولة بلا توكن. إضافة مصادقة هنا ستكسر العامل — خارج نطاق هذه الجولة.
- `/api/health` و `/api/status` عامة بلا أسرار (تعرض أسماء النماذج وhost الدمج فقط) — تُركت مفتوحة لفحص الجهوزية.
