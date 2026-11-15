import { randomUUID } from "node:crypto";
import type { Client, InValue } from "../../node_modules/@libsql/client/lib-esm/web.js";

/**
 * التهيئة الأولية للمفاتيح الافتراضية (Initial Provisioning):
 * تُخزَّن مفاتيح المزودات المجانية مباشرة في قاعدة بيانات Turso عند أول تشغيل
 * للسيرفر — فقط إن لم تكن موجودة مسبقًا. علامة seeded_default_keys في جدول meta
 * تضمن تنفيذ التهيئة مرة واحدة: حذف أي مفتاح لاحقًا من لوحة الإدارة يبقى فعليًا
 * ولا يُعاد إدراجه تلقائيًا عند إعادة النشر.
 */

const DEFAULT_KEYS: Array<{ provider: string; label: string; api_key: string }> = [
  {
    provider: "cloudflare",
    label: "Cloudflare 1",
    api_key: "e08d09833bdaa2835596ae8ae3caaebe:Cfut_63ivjYzp1ducMT0pkoJSnZBZiuyi3iMCLlVqZGMJ10766b48",
  },
  {
    provider: "cloudflare",
    label: "Cloudflare 2",
    api_key: "5e745500f924646c9c84d3142216b874:Cfut_LEZkFVhRprgHoOiL283e2Tlol9AuKgSRJmSdrNEv8b654e51",
  },
  {
    provider: "cloudflare",
    label: "Cloudflare 3",
    api_key: "792d94d404114a4300d1ee1558996cb7:Cfut_8NWHyWI0KBJffgadVFB88xfQfzImC3wGcVzMJ8fB436369bc",
  },
  {
    provider: "pollinations",
    label: "Pollinations Free",
    api_key: "free",
  },
];

const SEED_MARKER = "seeded_default_keys_v1";

/** إدراج المفاتيح الافتراضية الناقصة ثم تعليم العلامة — idempotent */
export async function seedDefaultKeys(db: Client): Promise<void> {
  const marker = await db.execute({
    sql: `SELECT value FROM meta WHERE key = ?`,
    args: [SEED_MARKER],
  });
  if (marker.rows.length > 0) return;

  for (const k of DEFAULT_KEYS) {
    const dup = await db.execute({
      sql: `SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1`,
      args: [k.provider, k.api_key],
    });
    if (dup.rows.length > 0) continue; // موجودة مسبقًا — لا تكرار
    const id = randomUUID();
    const args: InValue[] = [id, k.provider, k.label, k.api_key];
    await db.execute({
      sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?,?,?,?)`,
      args,
    });
    console.log(`[seed] أُضيف المفتاح الافتراضي: ${k.provider} / ${k.label}`);
  }

  await db.execute({
    sql: `INSERT INTO meta (key, value) VALUES (?, datetime('now')) ON CONFLICT(key) DO NOTHING`,
    args: [SEED_MARKER],
  });
}
