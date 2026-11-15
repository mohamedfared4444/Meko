/**
 * GET /api/cron — حذف المهام المنتهية (Cron يومي في vercel.json)
 */

const { cleanupExpired } = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "طريقة غير مسموحة — استخدم GET" }));
  }
  try {
    const deleted = await cleanupExpired();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, deleted }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
};
