import { createClient, type Client, type InValue } from "@libsql/client";
import type { ApiKeyRow, AttemptRecord, MediaType, ProviderId, TaskRow, TaskStatus } from "./types";

/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP.
 * عميل واحد مشترك + إنشاء المخطط تلقائيًا عند أول وصول (بلا أداة migrations)
 * حتى تعمل على Vercel serverless بلا أي ملفات محلية.
 */

let client: Client | null = null;

export function getTurso(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      throw new Error("TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان في متغيرات البيئة");
    }
    client = createClient({ url, authToken });
  }
  return client;
}

let schemaPromise: Promise<void> | null = null;

/** إنشاء الجداول عند أول وصول — CREATE TABLE IF NOT EXISTS */
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
      `);
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
    api_key: String(r.api_key),
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
// عمليات المفاتيح

/**
 * جلب مجمع المفاتيح بترتيب تسلسلي صارم حسب ترتيب الإضافة —
 * أول مفتاح أُضيف يُجرَّب أولًا (ليس round-robin وليس الأقل استخدامًا).
 * seq زيد تلقائيًا يضمن الترتيب حتى لو أُضيفا في نفس الثانية.
 * المفتاح المستنزف يبقى في القائمة؛ الاستثناء الوحيد هو التعطيل اليدوي.
 */
export async function getKeyPool(providers: ProviderId[]): Promise<ApiKeyRow[]> {
  await ensureSchema();
  if (providers.length === 0) return [];
  const placeholders = providers.map(() => "?").join(",");
  const r = await getTurso().execute({
    sql: `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${placeholders}) ORDER BY seq ASC`,
    args: providers,
  });
  return r.rows.map((row) => rowToKey(row as unknown as Record<string, unknown>));
}

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const r = await getTurso().execute(`SELECT * FROM api_keys ORDER BY seq ASC`);
  return r.rows.map((row) => rowToKey(row as unknown as Record<string, unknown>));
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: `SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1`,
    args: [provider, apiKey],
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
    args: [k.id, k.provider, k.label, k.api_key],
  });
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    api_key: k.api_key,
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
