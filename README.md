# Meko — خادم MCP لتوليد الوسائط بالذكاء الاصطناعي

خادم **MCP (Model Context Protocol)** يجمع ثلاث قدرات في أداة واحدة:

1. **توليد صور** من وصف نصي — الموديل: `gpt-image-2-6/flare-text-to-image`
2. **توليد فيديو بصوت متزامن أصلي** — الموديل: `grok-imagine-video-1-5-preview`
3. **دمج عدة مقاطع فيديو** في مقطع واحد عالي الجودة — عبر خدمة دمج مدمجة في هذا المستودع (مجلد `merger/`)

مع **لوحة إدارة عربية (RTL)** لإدارة مفاتيح API ومتابعة المهام حيًا وعرض إعدادات الربط جاهزة للنسخ لأي عميل MCP.

---

## القواعد الجوهرية

- **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر إطلاقًا؛ تُخزَّن روابط النتائج في قاعدة البيانات.
- **مفاتيح تسلسلية صارمة** — أول مفتاح أُضيف يُجرَّب أولًا، مع **تبديل تلقائي فوري** عند أي خطأ أو نفاد رصيد دون توقف؛ نفس المهمة تُستأنف بنفس `task_id` على المفتاح التالي.
- **نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا** — التبديل صامت تمامًا من وجهة نظره.
- مهمة فشل إنشاؤها على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة 45 ثانية).
- إخفاء المفاتيح إلزامي في كل الاستجابات (`maskKey`)، ولا أسرار في Git (`‎.env*` مستثنى).
- ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة.

---

## الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة من وصف نصي (aspect_ratio / resolution / background / output_format) |
| `generate_video` | توليد فيديو بصوت متزامن (image-to-video اختياري، مدة 1–15 ثانية) |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب عبر `urls` أو `task_ids` لمهام مكتملة |
| `get_task` | تتبع أي مهمة بمعرّفها — يحدّث من المزود/خدمة الدمج حيًا |
| `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها |

التوليد غير متزامن: الأداة تعيد `task_id` فورًا (مع نافذة انتظار قصيرة تبث تقدمًا حيًا)، والعميل يتابع بـ `get_task` كل ~10 ثوانٍ.

## الموديلات

| canonical | النوع | المزودون |
|---|---|---|
| `gpt-image-2-6/flare-text-to-image` | صورة | kie.ai + CometAPI |
| `grok-imagine-video-1-5-preview` | فيديو | kie.ai + CometAPI |
| `grok-imagine-image-2-0/segment-edit` | تعديل صور بالتجزئة (يحتاج `image_task_id` + `mask_indexs` لمهمة Grok صور سابقة) | kie.ai |

> ملاحظة: `grok-imagine-image-2-0/segment-edit` موديل **تعديل صور** وليس موديل فيديو — موديل الفيديو الموثق لدى kie.ai هو `grok-imagine-video-1-5-preview`.

أسماء الموديلات قابلة للتجاوز بمتغيرات البيئة (`KIE_IMAGE_MODEL` وغيرها).

---

## بنية المستودع

```
├── src/app/mcp/route.ts          # خادم MCP (SDK الرسمي + Streamable HTTP، وضع Stateless)
├── src/app/api/                  # health / keys / tasks (لوحة التحكم)
├── src/components/dashboard.tsx  # الواجهة العربية RTL
├── src/lib/
│   ├── turso.ts                  # طبقة قاعدة البيانات (Turso عبر HTTP)
│   ├── coordinator.ts            # منسق التوليد + التبديل التسلسلي + الدمج
│   ├── providers/                # محولات kie.ai و CometAPI
│   ├── merger.ts                 # عميل خدمة الدمج
│   ├── models.ts                 # سجل الموديلات
│   └── errors.ts                 # تصنيف الأخطاء (disabled/exhausted/provider/params/temporary)
└── merger/                       # موقع دمج الفيديو (مشروع Vercel مستقل)
    ├── api/                      # نقاط النهاية (jobs/upload/process/video/config/cron)
    ├── lib/merge.js              # محرك ffmpeg (H.264 CRF 18 + AAC، حتى 1080p)
    ├── public/index.html         # واجهة عربية داكنة بسحب وإفلات
    └── scripts/                  # اختبارات الوحدات و HTTP (26 اختبارًا)
```

---

## التشغيل محليًا

```bash
bun install        # أو npm install
cp .env.example .env.local   # ثم املأ قيم Turso
bun run dev        # http://localhost:3000
```

اختبار سريع للمسار MCP:

```bash
# تهيئة جلسة
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'

# استدعاء أداة (وضع Stateless — بلا معرّف جلسة)
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_media","arguments":{}}}'
```

---

## النشر على Vercel (مشروعان)

### المشروع الأول — التطبيق الرئيسي (Next.js)

1. ارفع المستودع إلى GitHub.
2. على [vercel.com](https://vercel.com): **Add New → Project → Import** المستودع.
3. اترك **Root Directory** فارغًا (جذر المستودع) — سيكتشف Next.js تلقائيًا.
4. أضف متغيرات البيئة:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `MERGER_API_BASE` (رابط المشروع الثاني بعد نشره)
   - اختياري: `MCP_ACCESS_TOKEN`
5. **Deploy**. يعمل كل شيء لأن libSQL يتصل عبر HTTP ومناسب للـ serverless.

> خطة Vercel المجانية (Hobby) تحدد مدة الدالة بـ 60 ثانية — نافذة انتظار MCP تُقصّ تلقائيًا عند 45 ثانية (`MCP_MAX_WAIT_SECONDS`). إن كانت لديك خطة Pro ارفعها حتى 240 لانتظار أطول داخل الاستدعاء الواحد.

### المشروع الثاني — موقع دمج الفيديو (مجلد `merger/`)

1. على Vercel: **Add New → Project** من نفس المستودع.
2. في الإعدادات اضبط **Root Directory = `merger`** (Framework Preset: Other).
3. أضف متغيري `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (يمكن استخدام نفس قاعدة Turso).
4. **Deploy**، ثم ضع رابط النشر في `MERGER_API_BASE` لمشروع الأول.

حدود خدمة الدمج: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد، والحذف التلقائي بعد 24 ساعة (Cron يومي في `vercel.json`).

---

## اختبار خدمة الدمج محليًا

```bash
cd merger
npm install
cp .env.example .env   # املأ متغيري Turso
npm run dev            # http://localhost:8787
npm run test:unit      # اختبارات الوحدات (13 اختبارًا)
npm run test:http      # اختبارات HTTP (22 اختبارًا) ضد الخادم الجاري
```

---

## قاعدة البيانات (Turso)

```bash
# إنشاء قاعدة مجانية
turso db create meko
turso db show meko --url        # ← TURSO_DATABASE_URL
turso db tokens create meko     # ← TURSO_AUTH_TOKEN
```

المخطط يُنشأ تلقائيًا عند أول وصول (`CREATE TABLE IF NOT EXISTS`) — جداول `tasks` و `api_keys` بعمود `seq` تلقائي الزيادة يضمن الترتيب التسلسلي الصارم للمفاتيح.

---

## ربط العملاء

من لوحة التحكم بطاقة «ربط السيرفر» تعرض JSON جاهزًا لكل عميل:

- **ChatGPT**: Settings → Connectors → Create → Custom MCP server → ضع `<origin>/mcp` في «Server URL».
- **Claude Desktop**: ملف `claude_desktop_config.json` بصيغة `"type": "http"`.
- **Cursor / Windsurf / Cline**: ملف `mcp.json`.

إن ضُبط `MCP_ACCESS_TOKEN` يُطلب `Authorization: Bearer <token>` على `/mcp`.

---

## أمان المفاتيح

- المفاتيح تُدار من الواجهة وتُخزَّن في قاعدة البيانات.
- كل الاستجابات تعرض المفاتيح مقنّعة (`ABCD123••••••••WXYZ`) — المفتاح الكامل لا يخرج من قاعدة البيانات أبدًا.
- فئات الأخطاء: `disabled` (مفتاح مرفوض → تعطيل تلقائي) / `exhausted` (نفاد رصيد → يبقى في القاعدة) / `provider` (موديل غير مدعوم) / `params` (توقف فورًا) / `temporary` (429 و5xx → انتقل للتالي).
