/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP.
 * كل شيء مخزّن هنا: بيانات المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs).
 * لا S3 ولا خدمات خارجية ولا ملفات محلية دائمة.
 */

const { createClient } = require("@libsql/client");

let client = null;
let schemaPromise = null;

function loadEnvFile() {
  // تحميل .env يدويًا — بلا أي اعتماديات
  try {
    const fs = require("fs");
    const path = require("path");
    const envPath = path.join(__dirname, "..", ".env");
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
      }
    }
  } catch {
    /* تجاهل */
  }
}

function getDb() {
  if (!client) {
    loadEnvFile();
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      throw new Error("TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان في متغيرات البيئة");
    }
    client = createClient({ url, authToken });
  }
  return client;
}

/** إنشاء الجداول عند أول وصول — بلا أداة migrations */
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getDb();
      await db.executeMultiple(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          status TEXT DEFAULT 'queued',
          progress INTEGER DEFAULT 0,
          sources_json TEXT DEFAULT '[]',
          error TEXT,
          video_url TEXT,
          download_url TEXT,
          size INTEGER,
          duration REAL,
          resolution TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT
        );
        CREATE TABLE IF NOT EXISTS source_chunks (
          job_id TEXT NOT NULL,
          source_seq INTEGER NOT NULL,
          chunk_seq INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, source_seq, chunk_seq)
        );
        CREATE TABLE IF NOT EXISTS output_chunks (
          job_id TEXT NOT NULL,
          chunk_seq INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, chunk_seq)
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_expires ON jobs (expires_at);
      `);
    })().catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

// ---------------------------------------------------------------------------
// الحدود القابلة للضبط (متغيرات البيئة)

function numEnv(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const LIMITS = {
  MAX_SOURCES: () => numEnv("MAX_SOURCES", 10),
  SOURCE_MAX_MB: () => numEnv("SOURCE_MAX_MB", 200),
  OUTPUT_MAX_MB: () => numEnv("OUTPUT_MAX_MB", 150),
  MAX_TOTAL_DURATION_SEC: () => numEnv("MAX_TOTAL_DURATION_SEC", 600),
  CHUNK_ROW_BYTES: 2 * 1024 * 1024, // صفوف 2MB — حد HTTP في Turso
  UPLOAD_CHUNK_BYTES: 4 * 1024 * 1024, // أجزاء الرفع 4MB — حد حجم الطلب في Vercel ≈4.5MB
  FFMPEG_PRESET: () => process.env.FFMPEG_PRESET || "medium",
};

// ---------------------------------------------------------------------------
// عمليات المهام

async function insertJob(job) {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO jobs (id, status, sources_json, expires_at) VALUES (?,?,?,?)`,
    args: [job.id, job.status || "queued", job.sources_json || "[]", job.expires_at],
  });
}

async function getJob(id) {
  await ensureSchema();
  const r = await getDb().execute({ sql: `SELECT * FROM jobs WHERE id = ?`, args: [id] });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: String(row.id),
    status: String(row.status),
    progress: Number(row.progress || 0),
    sources: safeParse(row.sources_json, []),
    error: row.error || null,
    video_url: row.video_url || null,
    download_url: row.download_url || null,
    size: row.size === null || row.size === undefined ? null : Number(row.size),
    duration: row.duration === null || row.duration === undefined ? null : Number(row.duration),
    resolution: row.resolution || null,
    created_at: String(row.created_at || ""),
    expires_at: row.expires_at ? String(row.expires_at) : null,
  };
}

async function updateJob(id, patch) {
  await ensureSchema();
  const sets = [];
  const args = [];
  const map = {
    status: "status",
    progress: "progress",
    sources_json: "sources_json",
    error: "error",
    video_url: "video_url",
    download_url: "download_url",
    size: "size",
    duration: "duration",
    resolution: "resolution",
    expires_at: "expires_at",
  };
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) {
      sets.push(`${col} = ?`);
      args.push(patch[k]);
    }
  }
  sets.push(`updated_at = datetime('now')`);
  args.push(id);
  await getDb().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

/** حذف شامل: صفوف المهمة من كل الجداول في batch واحد */
async function deleteJobCascade(id) {
  await ensureSchema();
  const db = getDb();
  await db.batch(
    [
      { sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM jobs WHERE id = ?`, args: [id] },
    ],
    "write",
  );
}

/** التنظيف الكسول: حذف المهام المنتهية (expires_at = created_at + 24 ساعة) */
async function cleanupExpired() {
  await ensureSchema();
  const db = getDb();
  const r = await db.execute(`SELECT id FROM jobs WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')`);
  const ids = r.rows.map((row) => String(row.id));
  for (const id of ids) {
    await deleteJobCascade(id);
  }
  return ids.length;
}

// ---------------------------------------------------------------------------
// تخزين Blobs المجزأة (صفوف 2MB) — للمصادر المرفوعة والناتج

async function saveBlobRows(table, idCols, idValues, blob) {
  // table: 'source_chunks' | 'output_chunks' — idCols: أعمدة المفتاح المركب
  const db = getDb();
  const chunkSize = LIMITS.CHUNK_ROW_BYTES;
  const statements = [];
  for (let i = 0, seq = 0; i < blob.length; i += chunkSize, seq++) {
    const part = blob.subarray(i, Math.min(i + chunkSize, blob.length));
    statements.push({
      sql: `INSERT OR REPLACE INTO ${table} (${idCols.join(",")}, chunk_seq, data) VALUES (${idCols.map(() => "?").join(",")}, ?, ?)`,
      args: [...idValues, seq, Buffer.from(part)],
    });
  }
  if (statements.length === 0) {
    // ملف فارغ — صف واحد فارغ حتى يعمل الاسترجاع
    statements.push({
      sql: `INSERT OR REPLACE INTO ${table} (${idCols.join(",")}, chunk_seq, data) VALUES (${idCols.map(() => "?").join(",")}, 0, ?)`,
      args: [...idValues, Buffer.alloc(0)],
    });
  }
  await db.batch(statements, "write");
}

async function readBlobSize(table, whereCols, idValues) {
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT COALESCE(SUM(length(data)), 0) AS total FROM ${table} WHERE ${whereCols.map((c) => `${c} = ?`).join(" AND ")}`,
    args: idValues,
  });
  return Number(r.rows[0]?.total || 0);
}

/** قراءة مجال بايتات [start..end] من Blob المخزّن صفحات 8 صفوف مع تتبع الإزاحة العامة */
async function streamBlobRange(table, whereCols, idValues, start, end, onData) {
  const db = getDb();
  const pageSize = 8;
  let globalOffset = 0; // الإزاحة العالمية لبداية الصف الحالي
  let offset = 0; // إزاحة الصفحات في SQL
  let delivered = 0;
  const total = end - start + 1;

  for (;;) {
    const r = await db.execute({
      sql: `SELECT data FROM ${table} WHERE ${whereCols.map((c) => `${c} = ?`).join(" AND ")} ORDER BY chunk_seq LIMIT ${pageSize} OFFSET ${offset}`,
      args: idValues,
    });
    if (r.rows.length === 0) break;
    for (const row of r.rows) {
      const buf = Buffer.isBuffer(row.data) ? Buffer.from(row.data) : Buffer.from(row.data);
      const rowStart = globalOffset;
      const rowEnd = globalOffset + buf.length - 1;
      globalOffset = rowEnd + 1;
      if (rowEnd < start) continue; // الصف كله قبل المجال المطلوب
      if (rowStart > end) return delivered; // تجاوزنا المجال
      const sliceStart = Math.max(0, start - rowStart);
      const sliceEnd = Math.min(buf.length - 1, end - rowStart);
      await onData(buf.subarray(sliceStart, sliceEnd + 1));
      delivered += sliceEnd - sliceStart + 1;
      if (delivered >= total) return delivered;
    }
    offset += pageSize;
  }
  return delivered;
}

function safeParse(json, fallback) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

module.exports = {
  getDb,
  ensureSchema,
  LIMITS,
  insertJob,
  getJob,
  updateJob,
  deleteJobCascade,
  cleanupExpired,
  saveBlobRows,
  readBlobSize,
  streamBlobRange,
  safeParse,
};
