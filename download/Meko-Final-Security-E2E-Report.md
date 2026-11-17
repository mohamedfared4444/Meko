# التقرير النهائي — Meko: تجهيز الأتمتة، الأمن، والاختبار الشامل

التاريخ: 2026-11-18 — كل الاختبارات المذكورة نُفّذت فعليًا على النشر الحي (meko-nine.vercel.app)، لا تخمين ولا افتراض.

---

## A. حالة المشروع

| المكوّن | الحالة | الدليل |
|---|---|---|
| **Core** (meko-nine.vercel.app) | يعمل — نشرات 21a6c5d و 78c0f8d حيّة | `Vercel – meko → success` على GitHub commit status؛ `/api/health`: ok=true |
| **Manager** (meko-manger.vercel.app) | يعمل | `merger.healthy=true`؛ استقبال الحمولة والأجزاء والويب هوك تمت فعليًا في الاختبار |
| **Renderer** (mohamedfared4444/meko-renderer) | يعمل — بلا أي تعديل | نسخة الملفات المحلية مطابقة بايت-ببايت للنسخة على `main` العام (diff فارغ) |
| **قاعدة Turso** | متصلة وسليمة | 63+ مهمة؛ الجلسات وحدّ المحاولات يخزنان في `meta` ويعملان عبر النسخ |
| **لوحة التحكم** | تعمل بعد الحماية | اختبار متصفح حقيقي: بوابة دخول للغير → لوحة كاملة للمصرح له (لقطة إثبات) |

## B. التعديلات

### الملفات التي فُحصت (بالكود لا بالتقارير)
`src/app/api/automate/video/route.ts`، `src/lib/codevideo.ts` (706 سطر)، `merger/api/render-payload.js`، `merger/api/render-complete.js` (438 سطر)، `merger/api/meta.js`، `merger/lib/db.js`، `.github/workflows/render-code-video.yml`، `scripts/render-code-video.js` (1213 سطر)، `src/app/api/keys/**`، `src/app/api/tasks/**`، `src/app/api/health|status|maintenance/**`، `src/app/mcp/route.ts` (575 سطر)، `src/components/dashboard.tsx` + `new-task-modal.tsx`، `src/lib/{turso,merger,tts,upload,env,auth,healthcheck}.ts`، `vercel.json`، `.gitignore`، تاريخ Git كاملًا بحثًا عن الأسرار، ومتغيرات البيئة المرجعية (أسماء فقط).

### الملفات المعدّلة والcommits

**Commit `21a6c5d` — التأمين:**
| الملف | التعديل |
|---|---|
| `src/lib/auth.ts` | **جديد**: مصادقة موحدة — مفتاح سري واحد (env `AUTOMATION_API_KEY` ثم `meta.automation_key`)، مقارنة `timingSafeEqual`، جلسات كوكي HttpOnly مخزنة في Turso (`dash_session:*`، سقف 25، حذف تلقائي للمنتهية)، حدّ محاولات دخول |
| `src/app/api/auth/{login,status,logout}/route.ts` | **جديد**: دخول بكلمة المرور = مفتاح الأتمتة → كوكي `meko_session` (HttpOnly+Secure+SameSite=Strict، 7 أيام)؛ status بلا كشف أي قيمة؛ خروج يلغي الجلسة خادميًا |
| `src/app/api/keys/route.ts` | مصادقة على GET/POST (جلسة لوحة أو Bearer) |
| `src/app/api/keys/[id]/route.ts` | مصادقة على PATCH/DELETE |
| `src/app/api/tasks/route.ts` | مصادقة على GET/POST |
| `src/app/api/tasks/create/route.ts` | مصادقة على POST |
| `src/app/api/tasks/rerender/route.ts` | مصادقة على POST |
| `src/app/api/automate/video/route.ts` | توحيد المصادقة على `@/lib/auth` (نفس السلوك: Bearer + timingSafeEqual) |
| `src/app/api/maintenance/{pipeline,dbfix}/route.ts` | **إزالة السر المكتوب في الكود** (`0f4c…` كان متتبعًا في Git) → env `MAINTENANCE_KEY` + timingSafeEqual؛ مسار `x-vercel-cron` الداخلي بقي يعمل |
| `src/app/mcp/route.ts` | مقارنة التوكن بـ timingSafeEqual بدل `===` |
| `src/components/dashboard.tsx` | بوابة دخول (LoginGate) + شاشة تحقق أولية + تحويل تلقائي للبوابة عند أي 401 — **بلا أي توكن في كود الواجهة، بلا Local/Session Storage، بلا NEXT_PUBLIC** |
| `scripts/test_captions_logic.js` | إصلاح المسار المكسور (`renderer-repo/…` → `scripts/…`) — الاختبارات الـ45 عادت للعمل |
| `.gitignore` + `git rm --cached .env` | `.env` خرج من التتبع (+أنماط `.env.local` و`merger/.env`) |

**Commit `78c0f8d`**: حدّ محاولات الدخول نقلته من ذاكرة النسخة (لا يعمل عبر نسخ serverless) إلى Turso `meta` — أثبت فعاليته حيًا (429).

**Commit `21cd085`**: سكربتات اختبار E2E (`launch_e2e_auth_test.py` + `scene-e2e-auth-test.html` — تقرأ المفتاح من `.automation-key` ولا تحوي أي سر) + إصلاح رابط التحقق في `rotate_automation_key.py`.

### تدوير الأسرار المنفَّذ
- **مفتاح الأتمتة دُوِّر** وفق سير العمل المتبع (`scripts/rotate_automation_key.py`): مفتاح جديد 39 حرفًا مخزّن في `meta.automation_key` عبر `/api/meta` بالتحقق من القدرة، وحُفظ محليًا في `.automation-key` (غير متتبع، صلاحيات 600). **القيمة لم تُطبع في أي مخرجات.**
- **`.env`**: خرج من التتبع. محتواه مجرد `DATABASE_URL=file:…` محلي (36 حرفًا بلا أي توكن) — فلا سر حقيقي تسرب، ولا يلزم تدوير Turso بسببه.
- مسح تاريخ Git كاملًا: لا `TURSO_AUTH_TOKEN` حقيقي (فقط placeholders فارغة في `.env.example`)، و`ghp_` نص توثيقي في تعليق، ومفتاح `mkau…` غير موجود إطلاقًا في أي ملف متتبع أو تاريخ.

## C. الأمن (إجابات مباشرة)

| السؤال | الإجابة |
|---|---|
| هل أصبحت `/api/keys/` محمية؟ | **نعم** — GET/POST/PATCH/DELETE كلها ترفض بلا جلسة أو Bearer (حجب حي مُثبت 401) |
| هل أصبحت `/api/tasks/` محمية؟ | **نعم** — GET/POST/create/rerender كلها (حجب حي مُثبت 401) |
| هل تم تأمين `.env`؟ | **نعم** — خارج التتبع + gitignore؛ لا نسخ env أخرى متتبعة إلا الأمثلة الفارغة |
| هل تم تدوير الأسرار المطلوبة؟ | **مفتاح الأتمتة نعم**. Turso لا يحتاج تدويرًا — لا توكن حقيقي في التاريخ (مُسح بالكامل) |
| هل ظلت لوحة التحكم تعمل بعد الحماية؟ | **نعم** — اختبار متصفح فعلي: بوابة → خطأ لكلمة خاطئة → لوحة كاملة للجلسة الصحيحة |
| هل بقي أي خطر أمني؟ | نعم — قائمة صريحة في F أدناه |

**التوافق مع الخدمات الداخلية**: الخدمات الداخلية المصرح لها تستمر — العامل يخاطب meko-manger فقط (قدرة UUID، لم تُمَس)، وبوابة الأتمتة تقبل Bearer كما هي، و/api/tasks و/api/keys تقبلان Bearer للأتمتة الخارجية المستقبلية.

## D. نتائج الاختبارات — كلها نُفّذت فعليًا

| الاختبار | النتيجة | الدليل |
|---|---|---|
| API Authentication | **PASS** | بلا ترويسة: 401 على keys/tasks/create/rerender/automate؛ Bearer خاطئ: 401؛ Bearer صحيح: 200؛ مقارنة timingSafeEqual في الكود |
| Dashboard | **PASS** | متصفح حقيقي: بوابة مخفية البيانات → خطأ لكلمة خاطئة → دخول ناجح → عرض المهام والمفاتيح والأزرار |
| Turso Connection | **PASS** | health: turso-connected؛ المهام والجلسات تُقرأ/تُكتب فعليًا |
| Audio Generation | **PASS** | Edge-TTS عربي (ar-EG-ShakirNeural): MP3 مرفوع، مدة الصوت 9.97s صارت مدة الفيديو |
| Word Timings | **PASS** | توقيتات مولّدة من نفس نداء Edge-TTS؛ الترجمة تزامنت مع النطق في الإطارات المستخرجة |
| Payload Storage | **PASS** | الحمولة خُزنت على meko-manger وأُطلق الـ workflow بـ payload_url (الاسترجاع تم لدى العامل — الرندر تم بكل العناصر) |
| GitHub Actions | **PASS** | run [44135182135](https://github.com/mohamedfared4444/meko-renderer/actions/runs/44135182135) success + run 44135703798 success (rerender) |
| Video Rendering | **PASS** | FHD كامل، خطوة الرندر 76 ثانية لـ299 إطارًا بلا تخفيض |
| MP4 Validation | **PASS** | ffprobe: h264 1080×1920 @30fps + AAC، 9.97s، moov قبل mdat (faststart)، والأبعاد زوجية بـ clampEven |
| Task Status Update | **PASS** | completed/100/video_url في Turso (polling أعادها)؛ اللوحة: stage=ready, renderHost=github-actions |
| Webhook / Status Polling | **PASS** | webhook.site استلم POST {task_id,status,video_url,title} مرتين (أصل + rerender)؛ polling GET يعمل بنفس الترويسة |
| Rerender | **PASS** | نفس task_id (بلا تكرار مهمة)، صوت مُعاد استخدامه (بلا إعادة توليد)، run جديد، رابط ناتج جديد، webhook ثانٍ |
| Captions Tests | **PASS** | 45/45 ناجح بعد إصلاح المسار (منطق phrase/single-pop/RTL/الأحجام) |
| حدّ محاولات الدخول | **PASS** | 429 بعد 10 فشلًا من IP واحد (مخزن Turso عبر النسخ) — مُثبت باتصال واحد ومتصفر حيًا من المتصفح |

## E. اختبار الفيديو النهائي (E2E حي)

| البند | القيمة |
|---|---|
| الطلب | POST /api/automate/video (Bearer المفتاح المُدوَّر) — عنوان عربي + سكربت عربي + `single-pop` + `ambient` |
| task_id | `58e72007-71b2-4c25-a5c6-1ad2e3a41352` |
| GitHub Actions Run | [44135182135](https://github.com/mohamedfared4444/meko-renderer/actions/runs/44135182135) — success (الرندر 76s) |
| رابط الفيديو | https://meko-manger.vercel.app/api/jobs/7a7857aa-7b67-416a-8dba-31e154f9bccc/video (نسخة rerender) |
| المدة | 9.97 ثانية (مدة الصوت الفعلية — بلا duration_seconds) |
| الدقة | 1080×1920 (التصميم/الملء مع تدوير الأبعاد الزوجية) |
| FPS | 30 ثابت — 299 إطارًا |
| الحجم | 514,601 بايت (~503KB) |
| سلامة MP4 | ffprobe سليم: h264+AAC، faststart (moov قبل mdat)؛ فحص بصري لإطارات: RTL عربي صحيح، ترجمة single-pop عند 74% (أبيض ≤5 أحرف)، شريط تقدم متزامن |
| نسخة محلية | `download/e2e-automation-test.mp4` |

## F. المشاكل المتبقية (صريحة، بلا تجاوز)

1. **`/mcp` مفتوح فعليًا الآن**: `MCP_ACCESS_TOKEN` غير مضبوط في Vercel (`authRequired: false`) — الكود جاهز بالمصادقة لكن ضبط المتغير يتطلب الوصول إلى إعدادات Vercel (غير متاح من هنا). **الإجراء المطلوب منك**: أضف `MCP_ACCESS_TOKEN` في Vercel (Production) ثم أعد النشر — دقيقة واحدة.
2. **نقاط meko-manger بلا مصادقة (تصميم قائم)**: `/api/render-payload` GET و`/api/jobs` و`/api/codevideo` تعتمد "معرفة القدرة" (UUID). إضافة مصادقة ستكسر العامل الحالي — تحتاج جولة متزامنة (عامل + Core معًا). الخطر عملي منخفض (UUIDs غير قابلة للتخمين، TTL 24h) لكن الخدمة تصلح لرندر HTML لأي جهة تعرف العنوان.
3. **حدّ محاولات الدخول لكل IP**: لو المهاجم وزّع الطلبات على IPs كثيرة يتفادى الحد — قابل للتحسين لاحقًا (Vercel WAF / حزمة عالمية).
4. **التوكن في remote URL محليًا**: بيانات دفع GitHub مضمّنة في `.git/config` على هذه البيئة فقط (ليست في أي ملف متتبع) — ممارسة مقبولة هنا، ويُفضل لاحقًا `gh auth` أو SSH.
5. **الرندر الاحتياطي بلا توكن** (مسار vercel السريع) يعتمد على عدم وجود GITHUB_TOKEN — بقي كما هو بلا تغيير (يعمل).
6. **مهام الاختبار في القاعدة**: مهمة E2E `58e72007…` متروكة عمدًا في الأرشيف كدليل (لم تُحذف أي بيانات إنتاجية).

## G. الخطوة التالية

**المشروع جاهز للربط مع n8n أو أي أداة أتمتة خارجية مجانية — الآن.** البوابة الكاملة تعمل ومحمية ومختبرة E2E:

```
POST https://meko-nine.vercel.app/api/automate/video
Authorization: Bearer <المفتاح في .automation-key>
{ title, script, voice, html_code, caption_style, bg_music_url, webhook_callback_url }
→ استجابة فورية { task_id, status_url }
→ POST إلى webhook_callback_url عند الاكتمال { task_id, status, video_url, title }
   أو استعلام GET status_url كل 15 ثانية
→ إعادة رندر: POST نفس المسار { action: "rerender", task_id }
```

المقترح بالترتيب:
1. اضبط `MCP_ACCESS_TOKEN` في Vercel (إغلاق آخر باب — دقيقة).
2. (اختياري) اضبط `MAINTENANCE_KEY` في Vercel إن احتجت النداء اليدوي لنقاط الصيانة (بدونه تبقى cron فقط).
3. في n8n (المجاني ذاتي الاستضافة، أو n8n Cloud الخطة المجانية): Webhook Trigger → HTTP Request للبوابة → Wait/Poll على status_url → تسليم video_url. عوّض أخطاء 401/429 بمهلة.
4. احفظ مفتاح `.automation-key` في مكان آمن عندك (هو الآن كلمة مرور اللوحة ومفتاح البوابة معًا) — وإن أردت الفصل لاحقًا: ضبط `ADMIN_PASSWORD` منفصل جولة قادمة.
