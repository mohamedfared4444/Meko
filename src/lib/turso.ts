// عميل Turso الويب (HTTP خالص عبر fetch) — يُستورد بمسار الملف مباشرة وليس باسم الحزمة:
// Next.js يخترج اسم الحزمة "@libsql/client" افتراضيًا (قائمة server-external-packages)
// ونسخ standalone للحزمة الخارجية ناقص (ملفات web.mjs/node.cjs و ws مفقودة) فيفشل التحميل
// وقت التشغيل على serverless. الاستيراد المباشر للملف يجبر المُجمّع على تضمين السلسلة كاملة
// داخل حزمة الدالة — بلا قراءة node_modules وقت التشغيل نهائيًا.
import { createClient, type Client, type InValue } from "../../node_modules/@libsql/client/lib-esm/web.js";
import { maskEnvValue, normalizeTursoUrl, sanitizeApiKey, sanitizeEnvValue } from "@/lib/env";
import { seedDefaultKeys } from "./seed";
import type { ApiKeyRow, AttemptRecord, MediaType, ProviderId, TaskRow, TaskStatus } from "./types";

/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP خالص (عميل الويب @libsql/client/web).
 * لماذا عميل الويب؟ يستخدم fetch القياسي فقط بلا أي مكتبات أصلية (native) —
 * يعمل بشكل مضمون داخل Vercel Serverless دون أخطاء Invalid URL أو فشل تحميل الوحدات.
 *
 * تعقيم المتغيرات قبل الاستخدام (وحدة @/lib/env المشتركة):
 *  - trim: إزالة المسافات والأسطر الجديدة من الطرفين
 *  - إزالة الاقتباسات المحيطة (خطأ شائع عند لصق القيمة داخل Vercel مع علامتي تنصيص)
 *  - إزالة الأحرف غير المرئية: علامات الاتجاه RTL/LRM، المسافة الصفرية، NBSP، BOM —
 *    تُدخل عند نسخ الرابط من محادثات وتجعل new URL() يرمي «Invalid URL»
 *  - تحويل libsql:// إلى https:// تلقائيًا ليتوافق مع عميل الويب وبيئة Serverless
 *
 * عميل واحد مشترك + إنشاء المخطط تلقائيًا عند أول وصول (Auto-migrate بلا أداة migrations)
 * حتى تعمل على Vercel serverless بلا أي ملفات محلية.
 */

// (تعقيم المتغيرات موحّد في @/lib/env)

function getDatabaseUrl(): string {
  const url = normalizeTursoUrl(process.env.TURSO_DATABASE_URL);
  if (!url) {
    throw new Error("TURSO_DATABASE_URL مفقود أو فارغ — أضفه في متغيرات البيئة (Vercel: Production) ثم أعد النشر.");
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(
      `صيغة رابط قاعدة البيانات غير صالحة (${maskEnvValue(url)}) — يجب أن يبدأ بـ libsql:// أو https://.`,
    );
  }
  return url;
}

function getAuthToken(): string {
  const token = sanitizeEnvValue(process.env.TURSO_AUTH_TOKEN);
  if (!token) {
    throw new Error("TURSO_AUTH_TOKEN مفقود أو فارغ — أضفه في متغيرات البيئة (Vercel: Production) ثم أعد النشر.");
  }
  return token;
}

let client: Client | null = null;

export function getTurso(): Client {
  if (!client) {
    client = createClient({ url: getDatabaseUrl(), authToken: getAuthToken() });
  }
  return client;
}

/**
 * تحويل أي فشل في الاتصال بقاعدة Turso إلى رسالة تشخيصية عربية واضحة —
 * تُعرض في /api/health وفي الواجهة لمعرفة السبب الحقيقي بدل «غير متصل» الصامتة.
 * لا تُسرّب التوكن أبدًا (تُقنّع إن ظهرت داخل رسالة المكتبة).
 */
export function describeDbError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  let m = raw;
  // قنّع التوكن إن ظهر نصه الكامل في رسالة الخطأ
  const token = process.env.TURSO_AUTH_TOKEN;
  if (token && m.includes(token)) m = m.replaceAll(token, "***TOKEN***");
  m = m.length > 220 ? m.slice(0, 220) + "…" : m;

  const msg = m.toLowerCase();
  // 1) متغيرات البيئة ناقصة (أشهر سبب بعد إضافة المتغيرات دون إعادة نشر)
  if (!sanitizeEnvValue(process.env.TURSO_DATABASE_URL) || !sanitizeEnvValue(process.env.TURSO_AUTH_TOKEN)) {
    return "متغيرات البيئة TURSO_DATABASE_URL / TURSO_AUTH_TOKEN غير موجودة في هذه البيئة — أضفها في Vercel (Production) ثم أعد النشر.";
  }
  // 2) صيغة الرابط (Invalid URL) — تُحل تلقائيًا بالتعقيم في الكود، لكن إن حدثت فالقيمة نفسها تالفة
  if (/invalid url|url_invalid|not in a valid format|url scheme not supported|failed to parse/.test(msg)) {
    return `صيغة TURSO_DATABASE_URL المضبوطة في Vercel تالفة (${maskEnvValue(
      sanitizeEnvValue(process.env.TURSO_DATABASE_URL),
    )}) — أعد لصقها بدون اقتباسات أو مسافات، وتأكد أنها تبدأ بـ libsql://. التفاصيل: ${m}`;
  }
  // 3) فشل توثيق
  if (/auth|unauthorized|401|forbidden|403|jwt|token.*invalid|invalid.*token|api key/.test(msg)) {
    return `فشل توثيق Turso — التوكن غير صالح أو منتهي الصلاحية. التفاصيل: ${m}`;
  }
  // 4) مشكلات شبكة/DNS (شائعة في أول تشغيل بارد أو حجب شبكة)
  if (/fetch failed|enotfound|econnrefused|econnreset|etimedout|timeout|network|dns|getaddrinfo|socket hang up|h2 protocol error/.test(msg)) {
    return `تعذر الوصول لخادم Turso عبر الشبكة (مؤقت غالبًا — أعد المحاولة). التفاصيل: ${m}`;
  }
  // 5) مشكلة تجميع/وحدات أصلية على serverless
  if (/module not found|cannot find module|could not find|dynamic require|no such builtin|webassembly|native/.test(msg)) {
    return `فشل تحميل مشغّل قاعدة البيانات داخل بيئة الخادم (serverless). التفاصيل: ${m}`;
  }
  // 6) أي شيء آخر — اعرض الرسبة المجزأة
  return `خطأ قاعدة البيانات: ${m}`;
}

let schemaPromise: Promise<void> | null = null;

/** إنشاء الجداول عند أول وصول — CREATE TABLE IF NOT EXISTS (Auto-migrate) */
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getTurso();
      await db.executeMultiple(`
        CREATE TABLE IF NOT EXISTS tasks (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS api_keys (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (seq DESC);
        CREATE INDEX IF NOT EXISTS idx_keys_pool ON api_keys (provider, status, seq);
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);
      // التهيئة الأولية: مفاتيح المزودات المجانية إن لم تكن موجودة — best-effort
      // (فشلها لا يُفشل إنشاء المخطط، ويعاد المحاولة في التشغيل البارد التالي)
      try {
        await seedDefaultKeys(db);
      } catch (e) {
        console.error("[seed] فشل تهيئة المفاتيح الافتراضية:", e instanceof Error ? e.message : String(e));
      }
    })().catch((e) => {
      schemaPromise = null; // اسمح بإعادة المحاولة في الطلب التالي
      throw e;
    });
  }
  return schemaPromise;
}

/** فحص جاهزية قاعدة البيانات */
export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    const r = await getTurso().execute("SELECT 1");
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// أدوات مساعدة

/** تحليل JSON آمن — يعيد القيمة الافتراضية عند أي خطأ */
function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function rowToTask(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r.id),
    provider: (r.provider as TaskRow["provider"]) ?? null,
    provider_task_id: (r.provider_task_id as string) ?? null,
    key_id: (r.key_id as string) ?? null,
    model: String(r.model),
    type: r.type as MediaType,
    prompt: (r.prompt as string) ?? "",
    params_json: (r.params_json as string) ?? "{}",
    status: r.status as TaskStatus,
    progress: Number(r.progress ?? 0),
    result_urls_json: (r.result_urls_json as string) ?? null,
    error_message: (r.error_message as string) ?? null,
    attempts_json: (r.attempts_json as string) ?? "[]",
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    completed_at: (r.completed_at as string) ?? null,
  };
}

function rowToKey(r: Record<string, unknown>): ApiKeyRow {
  return {
    id: String(r.id),
    provider: r.provider as ProviderId,
    label: (r.label as string) ?? "",
    // تعقيم دفاعي عند القراءة: مفاتيح ملصوقة من محادثات عربية قد تحمل أحرفًا
    // خفية تفشل ترويسات HTTP بـ ByteString — تُنقّى هنا فتصل نظيفة لكل مستهلك
    api_key: sanitizeApiKey(String(r.api_key)),
    status: (r.status as ApiKeyRow["status"]) ?? "active",
    usage_count: Number(r.usage_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: (r.last_used_at as string) ?? null,
    last_checked_at: (r.last_checked_at as string) ?? null,
    last_error: (r.last_error as string) ?? null,
    created_at: String(r.created_at ?? ""),
  };
}

// ---------------------------------------------------------------------------
// عمليات المهام

export async function insertTask(t: {
  id: string;
  model: string;
  type: MediaType;
  prompt: string;
  paramsJson: string;
  status: TaskStatus;
}): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, model, type, prompt, params_json, status) VALUES (?,?,?,?,?,?)`,
    args: [t.id, t.model, t.type, t.prompt, t.paramsJson, t.status],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({ sql: `SELECT * FROM tasks WHERE id = ?`, args: [id] });
  if (r.rows.length === 0) return null;
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>);
}

/** تحديث جزئي للمهمة + إضافة محاولة للسجل + ضبط completed_at تلقائيًا عند الاكتمال */
export async function updateTask(
  id: string,
  patch: Partial<{
    provider: TaskRow["provider"];
    provider_task_id: string | null;
    key_id: string | null;
    status: TaskStatus;
    progress: number;
    result_urls_json: string | null;
    error_message: string | null;
    params_json: string;
    model: string;
  }>,
  attempt?: AttemptRecord,
): Promise<TaskRow | null> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];

  if (attempt) {
    const current = await getTask(id);
    const list: AttemptRecord[] = current ? safeParse<AttemptRecord[]>(current.attempts_json, []) : [];
    list.push(attempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(list));
  }

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const col =
      k === "provider" ? "provider" :
      k === "provider_task_id" ? "provider_task_id" :
      k === "key_id" ? "key_id" :
      k === "status" ? "status" :
      k === "progress" ? "progress" :
      k === "result_urls_json" ? "result_urls_json" :
      k === "error_message" ? "error_message" :
      k === "params_json" ? "params_json" :
      k === "model" ? "model" : null;
    if (!col) continue;
    sets.push(`${col} = ?`);
    args.push(v as InValue);
  }

  if (patch.status === "completed") {
    sets.push("completed_at = datetime('now')");
  }
  sets.push("updated_at = datetime('now')");
  if (sets.length === 1) return getTask(id); // لا شيء للتحديث غير updated_at

  args.push(id);
  await getTurso().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
  return getTask(id);
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: MediaType; status?: TaskStatus },
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters?.type) {
    where.push("type = ?");
    args.push(filters.type);
  }
  if (filters?.status) {
    where.push("status = ?");
    args.push(filters.status);
  }
  args.push(limit);
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ?`;
  const r = await getTurso().execute({ sql, args });
  return r.rows.map((row) => rowToTask(row as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const r = await getTurso().execute(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('processing','pending') THEN 1 ELSE 0 END) AS processing
     FROM tasks`,
  );
  const row = r.rows[0] as unknown as Record<string, unknown>;
  return {
    total: Number(row?.total ?? 0),
    completed: Number(row?.completed ?? 0),
    failed: Number(row?.failed ?? 0),
    processing: Number(row?.processing ?? 0),
  };
}

/** حذف مهام (لتنظيف آثار الاختبار) */
export async function deleteTasks(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  await ensureSchema();
  const placeholders = ids.map(() => "?").join(",");
  const r = await getTurso().execute({ sql: `DELETE FROM tasks WHERE id IN (${placeholders})`, args: ids });
  return r.rowsAffected;
}

// ---------------------------------------------------------------------------
// إعدادات عامة (جدول meta — key/value)

/** قراءة قيمة إعداد مخزّن في جدول meta — null عند غيابه أو تعذر الوصول */
export async function getMeta(key: string): Promise<string | null> {
  try {
    await ensureSchema();
    const r = await getTurso().execute({ sql: `SELECT value FROM meta WHERE key = ?`, args: [key] });
    const v = r.rows[0]?.value;
    return v === null || v === undefined ? null : String(v);
  } catch {
    return null;
  }
}

/** كتابة/تحديث قيمة إعداد في جدول meta */
export async function setMeta(key: string, value: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}

// ---------------------------------------------------------------------------
// عمليات المفاتيح

/**
 * مفتاح من متغيرات البيئة كاحتياط — يُضاف نهاية المجمع بعد مفاتيح قاعدة البيانات،
 * حتى يعمل النشر على Vercel فورًا بمجرد ضبط KIE_API_KEY أو COMETAPI_API_KEY
 * دون الحاجة لإضافة مفاتيح يدويًا من لوحة الإدارة.
 */
function envKeyRow(provider: ProviderId): ApiKeyRow | null {
  // احتياط متغيرات البيئة للمزودات المدفوعة فقط — المزودات المجانية
  // (cloudflare/pollinations) تُدار حصريًا من قاعدة البيانات.
  const envName =
    provider === "kie" ? "KIE_API_KEY" :
    provider === "cometapi" ? "COMETAPI_API_KEY" : null;
  if (!envName) return null;
  const value = sanitizeEnvValue(process.env[envName]);
  if (!value) return null;
  return {
    id: `env-${provider}`,
    provider,
    label: `مفتاح البيئة (${envName})`,
    api_key: value,
    status: "active",
    usage_count: 0,
    success_count: 0,
    fail_count: 0,
    last_used_at: null,
    last_checked_at: null,
    last_error: null,
    created_at: "",
  };
}

/**
 * جلب مجمع المفاتيح بترتيب تسلسلي صارم حسب ترتيب الإضافة —
 * أول مفتاح أُضيف يُجرَّب أولًا (ليس round-robin وليس الأقل استخدامًا).
 * seq زيد تلقائيًا يضمن الترتيب حتى لو أُضيفا في نفس الثانية.
 * المفتاح المستنزف يبقى في القائمة؛ الاستثناء الوحيد هو التعطيل اليدوي.
 * مفتاح متغيرات البيئة (إن وُجد) يُضاف أخيرًا كاحتياط إضافي.
 */
export async function getKeyPool(providers: ProviderId[]): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const pool: ApiKeyRow[] = [];
  if (providers.length > 0) {
    const placeholders = providers.map(() => "?").join(",");
    const r = await getTurso().execute({
      sql: `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${placeholders}) ORDER BY seq ASC`,
      args: providers,
    });
    pool.push(...r.rows.map((row) => rowToKey(row as unknown as Record<string, unknown>)));
  }
  for (const p of providers) {
    const envRow = envKeyRow(p);
    if (envRow && !pool.some((k) => k.api_key === envRow.api_key)) pool.push(envRow);
  }
  return pool;
}

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const r = await getTurso().execute(`SELECT * FROM api_keys ORDER BY seq ASC`);
  return r.rows.map((row) => rowToKey(row as unknown as Record<string, unknown>));
}

/**
 * ملخص المفاتيح المعطلة لكل مزود — يُستخدم لتفسير سبب تخطي مزود كان مُدرجًا
 * في أولوية الموديل لكن لا توجد له مفاتيح نشطة في المجمع (شفافية التبديل).
 */
export async function disabledKeySummaries(
  providers: ProviderId[],
): Promise<Array<{ provider: ProviderId; count: number; lastError: string | null }>> {
  await ensureSchema();
  if (providers.length === 0) return [];
  const placeholders = providers.map(() => "?").join(",");
  const r = await getTurso().execute({
    sql: `SELECT provider, COUNT(*) AS n, MAX(last_error) AS last_error
          FROM api_keys
          WHERE status = 'disabled' AND provider IN (${placeholders})
          GROUP BY provider`,
    args: providers,
  });
  return r.rows.map((row) => ({
    provider: row.provider as ProviderId,
    count: Number(row.n ?? 0),
    lastError: row.last_error ? String(row.last_error).slice(0, 120) : null,
  }));
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: `SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1`,
    args: [provider, sanitizeApiKey(apiKey)],
  });
  return r.rows.length ? rowToKey(r.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function insertApiKey(k: {
  id: string;
  provider: ProviderId;
  label: string;
  api_key: string;
}): Promise<ApiKeyRow> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?,?,?,?)`,
    args: [k.id, k.provider, k.label, sanitizeApiKey(k.api_key)],
  });
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    api_key: sanitizeApiKey(k.api_key),
    status: "active",
    usage_count: 0,
    success_count: 0,
    fail_count: 0,
    last_used_at: null,
    last_checked_at: null,
    last_error: null,
    created_at: "",
  };
}

export async function getApiKey(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({ sql: `SELECT * FROM api_keys WHERE id = ?`, args: [id] });
  return r.rows.length ? rowToKey(r.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function setApiKeyStatus(id: string, status: ApiKeyRow["status"]): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: `UPDATE api_keys SET status = ? WHERE id = ?`, args: [status, id] });
}

export async function deleteApiKey(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: `DELETE FROM api_keys WHERE id = ?`, args: [id] });
}

/**
 * تحديث عدّادات المفتاح بعد كل استخدام — يُستدعى دائمًا (نجاح أو فشل).
 * عند فئة disabled → تعطيل تلقائي، وعند exhausted → تعليم مستنزف (يبقى في القاعدة).
 */
export async function recordKeyUsage(
  keyId: string,
  opts: { ok: boolean; error?: string; errorClass?: string },
): Promise<void> {
  await ensureSchema();
  const sets: string[] = ["usage_count = usage_count + 1", "last_used_at = datetime('now')", "last_checked_at = datetime('now')"];
  const args: InValue[] = [];
  if (opts.ok) {
    sets.push("success_count = success_count + 1", "last_error = NULL");
  } else {
    sets.push("fail_count = fail_count + 1", "last_error = ?");
    args.push((opts.error ?? "unknown").slice(0, 500));
    if (opts.errorClass === "disabled") sets.push("status = 'disabled'");
    if (opts.errorClass === "exhausted") sets.push("status = 'exhausted'");
  }
  args.push(keyId);
  await getTurso().execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args });
}
