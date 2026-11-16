/**
 * GET /api/dbfix?t=<SECRET>&mode=probe|apply
 *
 * نقطة نهاية صيانة مؤقتة (تُحذف بعد التنفيذ):
 * إصلاح مفاتيح مزود cloudflare في جدول api_keys بقاعدة Turso المشتركة —
 * حذف المفاتيح القديمة الميتة وإدراج المفتاح العام الجديد (صيغة cfk_) active.
 *
 * الأمان:
 *  - سر عشوائي في معامل t — أي نداء بلا السر يُجاب 404 عامة.
 *  - mode=probe: قراءة فقط (فحص وجود الجدول + قائمة مقنّعة) بلا أي كتابة.
 *  - mode=apply: idempotent عبر علامة في جدول meta (meko_cf_key_migration_2026).
 *  - فشل آمن: إن لم يوجد جدول api_keys في هذه القاعدة (قاعدة مختلفة) لا تُكتب
 *    أي شيء ويُعاد تقرير same_db:false.
 */

const crypto = require("crypto");

/** سر النداء — يُقارن ثابتًا لتجنب تسريب التوقيت */
const SECRET = "0f4c1e7a93b24d6e8a51c7f2b39d6408";

/**
 * تعقيم رابط قاعدة البيانات (نفس منطق التطبيق الرئيسي في src/lib/env):
 * trim + إزالة الاقتباسات المحيطة + إزالة الأحرف غير المرئية (RTL/LRM/NBSP/BOM)
 * + تحويل libsql:// إلى https:// ليتوافق مع عميل الويب.
 */
function sanitizeUrl(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/^["']+|["']+$/g, "");
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u00A0\uFEFF]/g, "");
  s = s.replace(/\s+/g, "");
  if (/^libsql:\/\//i.test(s)) s = "https://" + s.slice("libsql://".length);
  return s;
}

/** عميل Turso مباشر بعميل الويب الخالص (يعمل على serverless بلا وحدات أصلية) */
function makeDbClient() {
  const url = sanitizeUrl(process.env.TURSO_DATABASE_URL);
  const token = String(process.env.TURSO_AUTH_TOKEN || "").trim().replace(/^["']+|["']+$/g, "");
  if (!url || !token) {
    throw new Error(
      `متغيرات البيئة ناقصة: TURSO_DATABASE_URL=${url ? "موجود" : "مفقود"} | TURSO_AUTH_TOKEN=${token ? "موجود" : "مفقود"}`,
    );
  }
  // روابط Turso (https/libsql) → عميل الويب الخالص (HTTP فقط — مضمون على serverless).
  // روابط file: (تشغيل محلي فقط) → العميل الكامل لأن نسخة الويب لا تدعمها.
  const createClient =
    /^https?:\/\//i.test(url)
      ? require("@libsql/client/web").createClient
      : require("@libsql/client").createClient;
  return { client: createClient({ url, authToken: token }), urlShape: maskUrlShape(url) };
}

/** وصف آمن لشكل الرابط (بدون التوكن ولا المسار الكامل) */
function maskUrlShape(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const maskedHost = host.length > 12 ? host.slice(0, 8) + "…" + host.slice(-6) : host;
    return { protocol: u.protocol, host: maskedHost, has_query_auth: u.searchParams.has("authToken"), length: url.length };
  } catch {
    return { invalid: true, length: url.length };
  }
}

/** المفتاح الجديد بالصيغة الثلاثية كما سيُخزَّن (بادئة Cfk_ كما زوّد المستخدم) */
const NEW_KEY =
  "e08d09833bdaa2835596ae8ae3caaebe:mohamedfarid4109@gmail.com:Cfk_NUGDka8MsnVoIM9nF9nhRi3tYLbaVR59w1v6reai820b6fa9";
const NEW_LABEL = "Cloudflare Global Key";
const MARKER = "meko_cf_key_migration_2026";

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

/** قناع آمن للعرض — بداية المفتاح ونهايته فقط */
function maskKey(key) {
  const s = String(key || "");
  if (s.length <= 16) return s.slice(0, 4) + "***";
  return s.slice(0, 10) + "…" + s.slice(-4);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function tableExists(db, name) {
  const r = await db.execute({
    sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    args: [name],
  });
  return r.rows.length > 0;
}

async function listCloudflareKeys(db) {
  const r = await db.execute({
    sql: `SELECT id, label, api_key, status, usage_count, last_error FROM api_keys WHERE provider = 'cloudflare' ORDER BY seq ASC`,
  });
  return r.rows.map((row) => ({
    id: String(row.id),
    label: String(row.label || ""),
    masked: maskKey(row.api_key),
    status: String(row.status || ""),
    usage_count: Number(row.usage_count || 0),
    last_error: row.last_error ? String(row.last_error).slice(0, 120) : null,
  }));
}

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (!safeEqual(url.searchParams.get("t"), SECRET)) {
    return send(res, 404, { error: "المسار غير موجود" });
  }
  const mode = url.searchParams.get("mode") === "apply" ? "apply" : "probe";

  let db;
  let urlShape;
  try {
    const made = makeDbClient();
    db = made.client;
    urlShape = made.urlShape;
  } catch (e) {
    return send(res, 503, {
      error: "لا يمكن إنشاء عميل Turso: " + (e instanceof Error ? e.message : String(e)),
      url_shape: urlShape || null,
      mode,
    });
  }

  try {
    const hasKeys = await tableExists(db, "api_keys");
    if (!hasKeys) {
      return send(res, 200, {
        same_db: false,
        note: "جدول api_keys غير موجود في قاعدة هذه الخدمة — لا تُكتب أي بيانات (قاعدة مختلفة عن التطبيق الرئيسي).",
        mode,
        url_shape: urlShape,
      });
    }

    const before = await listCloudflareKeys(db);

    if (mode === "probe") {
      const metaR = await tableExists(db, "meta")
        ? await db.execute({ sql: `SELECT value FROM meta WHERE key = ?`, args: [MARKER] })
        : { rows: [] };
      return send(res, 200, {
        same_db: true,
        mode,
        already_applied: metaR.rows.length > 0,
        cloudflare_keys_before: before,
        total_keys: (await db.execute({ sql: `SELECT COUNT(*) AS c FROM api_keys` })).rows[0].c,
        url_shape: urlShape,
      });
    }

    // mode=apply — idempotent عبر العلامة
    if (tableExists(db, "meta")) {
      const m = await db.execute({ sql: `SELECT value FROM meta WHERE key = ?`, args: [MARKER] });
      if (m.rows.length > 0) {
        const after = await listCloudflareKeys(db);
        return send(res, 200, {
          same_db: true,
          mode,
          applied: false,
          already_applied: true,
          note: "الترحيل نُفِّذ سابقًا — لا إجراء جديد.",
          cloudflare_keys_after: after,
        });
      }
    }

    const id = crypto.randomUUID();
    await db.batch(
      [
        { sql: `DELETE FROM api_keys WHERE provider = 'cloudflare'`, args: [] },
        {
          sql: `INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?,?,?,?,?)`,
          args: [id, "cloudflare", NEW_LABEL, NEW_KEY, "active"],
        },
        ...(tableExists(db, "meta")
          ? [{ sql: `INSERT INTO meta (key, value) VALUES (?, datetime('now')) ON CONFLICT(key) DO NOTHING`, args: [MARKER] }]
          : []),
      ],
      "write",
    );

    const after = await listCloudflareKeys(db);
    return send(res, 200, {
      same_db: true,
      mode,
      applied: true,
      deleted_count: before.length,
      cloudflare_keys_before: before,
      cloudflare_keys_after: after,
      url_shape: urlShape,
    });
  } catch (e) {
    return send(res, 500, {
      error: "فشل تنفيذ العملية على قاعدة البيانات: " + (e instanceof Error ? e.message : String(e)),
      mode,
      url_shape: urlShape || null,
    });
  }
};
