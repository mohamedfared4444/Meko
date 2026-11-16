/**
 * خادم تطوير محلي يحاكي بيئة Vercel:
 * - يحلّل المسارات الديناميكية ويضعها في req.query (مثل Vercel)
 * - يخدم public/ كملفات ثابتة
 * - يحمّل .env يدويًا
 * التشغيل: node server.js  (PORT افتراضي 8787)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

// تحميل .env يدويًا
(function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
})();

const jobsHandler = require("./api/jobs");
const jobHandler = require("./api/jobs/[id]");
const processHandler = require("./api/jobs/[id]/process");
const videoHandler = require("./api/jobs/[id]/video");
const uploadHandler = require("./api/upload");
const configHandler = require("./api/config");
const cronHandler = require("./api/cron");

const PORT = Number(process.env.PORT || 8787);

function wrap(fn) {
  return (req, res, query) => {
    Promise.resolve(fn(req, res))
      .catch((e) => {
        console.error("[api error]", e);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        }
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      });
    void query;
  };
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);
  req.query = Object.fromEntries(url.searchParams.entries());

  // نقاط النهاية — تُحلّل المسارات الديناميكية إلى req.query.id (كما في Vercel)
  if (pathname === "/api/jobs" && req.method === "POST") return wrap(jobsHandler)(req, res);
  const jobsIdMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobsIdMatch) {
    req.query.id = jobsIdMatch[1];
    return wrap(jobHandler)(req, res);
  }
  const processMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/process$/);
  if (processMatch) {
    req.query.id = processMatch[1];
    return wrap(processHandler)(req, res);
  }
  const videoMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/video$/);
  if (videoMatch) {
    req.query.id = videoMatch[1];
    return wrap(videoHandler)(req, res);
  }
  if (pathname === "/api/upload") return wrap(uploadHandler)(req, res);
  if (pathname === "/api/config") return wrap(configHandler)(req, res);
  if (pathname === "/api/cron") return wrap(cronHandler)(req, res);

  // الملفات الثابتة — الواجهة العربية
  if (pathname === "/" || pathname === "/index.html") {
    const file = path.join(__dirname, "public", "index.html");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(file));
  }
  sendJson(res, 404, { error: "المسار غير موجود" });
});

server.listen(PORT, () => {
  console.log(`✅ خادم دمج الفيديو يعمل على http://localhost:${PORT}`);
  console.log(`   قاعدة البيانات: ${process.env.TURSO_DATABASE_URL || "(غير مضبوط!)"}`);
});
