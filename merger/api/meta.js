/**
 * POST /api/meta — إدارة إعدادات جدول meta في قاعدة Turso المشتركة (نفس قاعدة Meko).
 *
 * الغرض: تخزين توكن GitHub الذي يقرأه Meko عند إطلاق الرندر الكامل
 * (src/lib/codevideo.ts → getGitHubToken() → getMeta("github_token")) — فيعمل
 * خط الفيديو البرمجي FHD 30fps على GitHub Actions دون متغيرات بيئة.
 *
 * الأمان بمعرفة القدرة (capability):
 *  - POST فقط.
 *  - المفتاح مقفول على قائمة بيضاء ثابتة (github_token للأتمتة الرندر،
 *    automation_key لبوابة الأتمتة) — لا يمكن كتابة أي مفتاح آخر عبر هذه النقطة.
 *  - op=set يتطلب ترويسة Authorization: Bearer <توكن> مساوية للقيمة المطلوب
 *    تخزينها، مع تحقق فعلي من التوكن ضد GitHub API (يجب أن يملك وصولًا إلى
 *    مستودع الرندر) — فلا يُخزَّن إلا توكن يعمل فعلًا، ولا يستطيع أحد غير
 *    مالك التوكن كتابته.
 *  - لا تُعاد القيمة كاملة أبدًا — قناع فقط (أول 4 أحرف + آخر 4).
 *
 * العمليات (جسم JSON):
 *  op=set   {key:"github_token", value:"ghp_…"}  — التحقق ثم الكتابة (upsert)
 *  op=check {key:"github_token"}                 — هل موجود؟ (بالقناع فقط)
 */

const { getDb, ensureSchema } = require("../lib/db");

/** المفاتيح المسموحة — توكن إطلاق الرندر + مفتاح بوابة الأتمتة */
const ALLOWED_KEYS = ["github_token", "automation_key"];
/** مستودع الرندر العام (meko-renderer) — التحقق أن التوكن يملك وصولًا إليه
 *  (env override للاختبار المحلي) */
const RENDER_REPO = String(process.env.GH_RENDER_REPO || "mohamedfared4444/meko-renderer");
/** صيغة توكن GitHub: أحرف/أرقام/شرطة سفلية، 20–255 حرفًا، بلا أي مسافات أو تحكم */
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return send(res, 405, { error: "طريقة غير مسموحة — استخدم POST مع جسم JSON" });
  }

  let body = {};
  try {
    body = JSON.parse((await readBody(req, 16 * 1024)).toString("utf8") || "{}") || {};
  } catch {
    return send(res, 400, { error: "جسم الطلب يجب أن يكون JSON صالحًا" });
  }

  const op = String(body.op || req.query.op || "check");
  const key = String(body.key || "");
  if (!ALLOWED_KEYS.includes(key)) {
    return send(res, 403, { error: `المفاتيح المسموحة: ${ALLOWED_KEYS.join("، ")} — رفض ${key ? `"${key}"` : "المفتاح الفارغ"}` });
  }

  try {
    if (op === "set") return await handleSet(req, res, body);
    if (op === "check") return await handleCheck(res, key);
    return send(res, 400, { error: "op غير معروف — استخدم set أو check" });
  } catch (e) {
    return send(res, 500, { error: e instanceof Error ? e.message.slice(0, 400) : String(e) });
  }
};

// ---------------------------------------------------------------------------
// op=set — التحقق من القدرة ثم الكتابة

async function handleSet(req, res, body) {
  const key = String(body.key || "");
  const value = String(body.value ?? "").trim();
  if (!TOKEN_RE.test(value)) {
    return send(res, 400, { error: "قيمة التوكن غير صالحة — أحرف/أرقام/شرطة سفلية فقط بطول 20–255 (بدون اقتباسات أو مسافات أو أسطر)" });
  }

  // إثبات القدرة: مَن يطلب التخزين يجب أن يملك التوكن نفسه (ترويسة Bearer)
  const auth = String(req.headers.authorization || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!bearer) {
    return send(res, 401, { error: "ترويسة Authorization: Bearer <توكن> مطلوبة — أثبت ملكية التوكن قبل تخزينه" });
  }
  if (bearer !== value) {
    return send(res, 403, { error: "الترويسة Bearer لا تطابق القيمة المطلوب تخزينها — رفض" });
  }

  // تحقق فعلي ضد GitHub API — للتوكن فقط (يجب أن يملك وصولًا إلى مستودع الرندر)؛
  // مفتاح الأتمتة سر منفصل بلا تحقق GitHub — إثبات الملكية بالترويسة يكفي
  if (key === "github_token") {
    const valid = await validateGitHubToken(value, RENDER_REPO);
    if (!valid) {
      return send(res, 400, {
        error: `التوكن فشل تحقق GitHub (لا يعمل أو بلا وصول إلى ${RENDER_REPO}) — تأكد من صلاحية repo/Actions وأعد المحاولة`,
      });
    }
  }

  // الكتابة في جدول meta المشترك (نفس قاعدة Meko — يقرأها getMeta(key))
  await ensureSchema();
  const db = getDb();
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  });
  await db.execute({
    sql: `INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });

  return send(res, 200, {
    ok: true,
    key,
    masked: mask(value),
    ...(key === "github_token" ? { repo: RENDER_REPO } : {}),
    note:
      key === "github_token"
        ? "المخزّن — Meko سيقرأه عند إطلاق الرندر الكامل (render_code_video)"
        : "المخزّن — بوابة الأتمتة POST /api/automate/video تقرأه عند كل نداء (Authorization: Bearer)",
  });
}

// ---------------------------------------------------------------------------
// op=check — الوجود والقناع فقط (بلا أي كشف للقيمة)

async function handleCheck(res, key) {
  await ensureSchema();
  const db = getDb();
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  });
  const r = await db.execute({
    sql: `SELECT value FROM meta WHERE key = ?`,
    args: [key],
  });
  const v = r.rows[0]?.value;
  const exists = v !== null && v !== undefined && String(v).length > 0;
  return send(res, 200, {
    ok: true,
    key,
    exists,
    masked: exists ? mask(String(v)) : null,
  });
}

// ---------------------------------------------------------------------------
// أدوات

/** تحقق التوكن ضد GitHub API — 200 على GET /repos/{repo} يعني صالحًا + وصول للمستودع */
async function validateGitHubToken(token, repo) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "meko-manger-meta",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** قناع آمن: أول 4 + آخر 4 فقط — لا يكفي لاستخدام التوكن ولا لكشف بنيته كاملة */
function mask(t) {
  if (t.length <= 10) return "****";
  return `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} حرفًا)`;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`الجسم أكبر من الحد ${maxBytes} بايت`));
        return;
      }
      chunks.push(Buffer.from(c));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
