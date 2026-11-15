# Meko — مولد الوسائط الذكي (MCP)

**Meko** خادم MCP (Model Context Protocol) لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — مع لوحة إدارة عربية كاملة، ومجمع مفاتيح بتبديل تلقائي عند أي فشل، وقاعدة بيانات Turso (libSQL).

## المزايا

- **خادم MCP جاهز للربط** بـ ChatGPT / GPT Agents / Claude Desktop / Cursor / Windsurf / Cline — على المسار `/mcp` عبر Streamable HTTP (وضع stateless متوافق مع Vercel serverless).
- **5 أدوات MCP**:

  | الأداة | الوظيفة | الموديل |
  |---|---|---|
  | `generate_image` | توليد صورة من وصف نصي | `gpt-image-2-6/flare-text-to-image` |
  | `generate_video` | توليد فيديو بصوت متزامن أصلي (نص أو صورة) | `grok-imagine-video-1-5-preview` |
  | `merge_videos` | دمج عدة مقاطع في فيديو واحد بالترتيب | خدمة الدمج (اختيارية) |
  | `get_task` | تتبع أي مهمة بمعرّفها حتى الاكتمال | — |
  | `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها | — |

- **موديل تعديل الصور بالتجزئة** `grok-imagine-image-2-0/segment-edit` — تعديل أجزاء محددة من صورة عبر `image_task_id` + `mask_indexs`.
- **مجمع مفاتيح بتبديل تلقائي صارم**: تُجرَّب المفاتيح بترتيب إضافتها، وعند أي خطأ مفتاح/رصيد/معدل تنتقل المهمة **بنفس المعرّف** للمفتاح التالي دون توقف — العميل لا يرى أبدًا أي خطأ مفاتيح.
- **دعم متغيرات البيئة كاحتياط**: ضبط `KIE_API_KEY` يكفي للتشغيل الفوري دون إضافة مفاتيح من اللوحة.
- **لوحة إدارة عربية RTL**: حالة قاعدة البيانات، إضافة/تعطيل/حذف المفاتيح مع إخفاء دائم للقيم، إحصاءات الاستخدام والنجاح والفشل، سجل المهام مع التقدم والروابط، ودليل ربط MCP لكل عميل.
- **قاعدة بيانات Turso (libSQL)** عبر HTTP — بلا migrations وبلا ملفات محلية، مثالية لـ serverless.

## نقاط النهاية

| المسار | الوصف |
|---|---|
| `GET /api/health` | الحالة: قاعدة البيانات، الموديلات، خدمة الدمج، المصادقة |
| `POST /api/keys` / `GET` | إدارة مفاتيح المزودين (kie / cometapi) |
| `PATCH/DELETE /api/keys/[id]` | تعطيل/تنشيط/حذف مفتاح |
| `GET /api/tasks` | أحدث المهام + إحصاءات |
| `POST /mcp` | خادم MCP (Streamable HTTP) — يدعم GET/DELETE أيضًا |

## متغيرات البيئة

| المتغير | إلزامي؟ | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | نعم | رابط قاعدة Turso `libsql://…` |
| `TURSO_AUTH_TOKEN` | نعم | توكن مصادقة Turso |
| `KIE_API_KEY` | احتياط | مفتاح kie.ai — يعمل مباشرة دون إضافة يدوية من اللوحة |
| `COMETAPI_API_KEY` | لا | مفتاح CometAPI كاحتياط إضافي |
| `MCP_ACCESS_TOKEN` | لا | حماية `/mcp` بمفتاح Bearer (يُنصح به للنشر العام) |
| `MCP_MAX_WAIT_SECONDS` | لا | نافذة الانتظار داخل الطلب (الافتراضي 45، الحد الأقصى 240) |
| `MERGER_API_BASE` | لا | رابط خدمة دمج الفيديو إن نشرتها (مجلد `merger/`) |

انسخ `.env.example` إلى `.env` واملأ القيم محليًا — ولا ترفع `.env` أبدًا.

## التشغيل المحلي

```bash
bun install
cp .env.example .env       # ثم املأ TURSO_DATABASE_URL و TURSO_AUTH_TOKEN و KIE_API_KEY
bun run dev                # http://localhost:3000
```

جرّب الحالة:

```bash
curl http://localhost:3000/api/health
```

## النشر على Vercel

1. ارفع المشروع إلى GitHub (يُتجاهل `.env` تلقائيًا).
2. على [vercel.com](https://vercel.com) → **Add New → Project** → اختر مستودع **Meko**.
3. لا تغيّر أي إعداد بناء — Next.js يُكتشف تلقائيًا. أضف **Environment Variables** التالية:

   ```
   TURSO_DATABASE_URL = libsql://…turso.io
   TURSO_AUTH_TOKEN   = eyJ…
   KIE_API_KEY        = …
   MCP_ACCESS_TOKEN   = اختياري لكن مستحسن
   ```

4. **Deploy** — وبعد النشر اختبر: `https://<مشروعك>.vercel.app/api/health`.

> حد خطة Hobby هو 60 ثانية لكل دالة — نافذة الانتظار مقصوصة داخليًا عبر `MCP_MAX_WAIT_SECONDS` والمهام الأطول تُتابَع بأداة `get_task`.

### خدمة دمج الفيديو (اختيارية)

مجلد `merger/` مشروع Vercel مستقل لدمج المقاطع (ffmpeg). انشره بنفس الطريقة (Root Directory: `merger`) وأضف متغيري Turso نفسهما، ثم ضع رابطه في `MERGER_API_BASE` على المشروع الرئيسي. بدونه تعمل كل الأدوات ما عدا `merge_videos`.

## ربط عملاء MCP

بعد النشر استبدل الرابط في الأمثلة التالية برابط مشروعك:

**ChatGPT / GPT Agents** (Developer mode → Actions أو موصل MCP):

```json
{ "mcpServers": { "meko": { "url": "https://<مشروعك>.vercel.app/mcp" } } }
```

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "meko": {
      "type": "mcp",
      "url": "https://<مشروعك>.vercel.app/mcp"
    }
  }
}
```

**Cursor / Windsurf / Cline** — ملف `mcp.json`:

```json
{
  "mcpServers": {
    "meko": { "url": "https://<مشروعك>.vercel.app/mcp" }
  }
}
```

لو ضبطت `MCP_ACCESS_TOKEN` أضف ترويسة `Authorization: Bearer <القيمة>` في إعدادات العميل.

### سير العمل المتوقع من العميل

1. `generate_image` أو `generate_video` — إن اكتملت داخل نافذة الانتظار ستعود الروابط فورًا.
2. إن أُعيدت حالة `PROCESSING` مع `task_id` فاستدعِ `get_task` كل ~10 ثوانٍ حتى `completed` (اعرض الروابط) أو `failed`.
3. لدمج مقاطع مكتملة استدعِ `merge_videos` بـ `task_ids` بالترتيب المطلوب ثم تابع بـ `get_task`.

## الأمان

- لا يُقرأ أي مفتاح في الواجهة مطلقًا — تُعرض قيم مقنّعة فقط (`abf6b97••••••••4293`).
- رسائل الأخطاء تُنقّى قبل وصولها للعميل: لا ذكر لمفاتيح أو أرصدة إطلاقًا.
- حماية اختيارية لـ `/mcp` عبر `MCP_ACCESS_TOKEN`.
