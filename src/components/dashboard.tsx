"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// أنواع بيانات الواجهة

interface HealthInfo {
  ok: boolean;
  database: string;
  dbError?: string | null;
  mcpEndpoint: string;
  models: Array<{ canonical: string; type: string; providers: string[] }>;
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

interface KeyItem {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface TaskItem {
  id: string;
  type: "image" | "video" | "merge";
  model: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  prompt: string;
  urls: string[];
  error: string | null;
  attempts: number;
  created_at: string;
}

interface TasksResponse {
  stats: { total: number; completed: number; failed: number; processing: number };
  tasks: TaskItem[];
}

// ---------------------------------------------------------------------------

const TOOLS: Array<{ name: string; desc: string }> = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي — Cloudflare (مجاني) ثم Pollinations (مجاني) ثم kie.ai مع تبديل تلقائي، مع إمكانية تحديد مزود معين" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي عبر grok-imagine-video-1-5-preview" },
  { name: "merge_videos", desc: "دمج عدة مقاطع فيديو في مقطع واحد بالترتيب المطلوب" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال وعرض الروابط" },
  { name: "list_media", desc: "استرجاع أحدث الصور والفيديوهات المخزنة بروابطها" },
];

/** تسميات المزودات المعروضة في الواجهة */
const PROVIDER_LABELS: Record<string, string> = {
  kie: "kie.ai",
  cometapi: "CometAPI",
  cloudflare: "Cloudflare AI",
  pollinations: "Pollinations",
};

/** تلميح صيغة المفتاح لكل مزود */
function providerHint(provider: string) {
  if (provider === "cloudflare") {
    return (
      <p className="text-[11px] leading-relaxed text-white/50">
        صيغة مفتاح Cloudflare: <code dir="ltr" className="font-mono text-white/70">ACCOUNT_ID:API_TOKEN</code> — مفصولين بنقطتين، ويُخزّنان معًا في قاعدة البيانات ويُفصلان تلقائيًا عند التوليد.
      </p>
    );
  }
  if (provider === "pollinations") {
    return (
      <p className="text-[11px] leading-relaxed text-white/50">
        مزود مجاني مفتوح بلا مفتاح حقيقي — اكتب <code dir="ltr" className="font-mono text-white/70">free</code> في حقل المفتاح لتخزينه وترتيبه ضمن المجمع.
      </p>
    );
  }
  return null;
}

function keyInputPlaceholder(provider: string): string {
  if (provider === "cloudflare") return "ACCOUNT_ID:API_TOKEN";
  if (provider === "pollinations") return "اكتب free (بلا مفتاح حقيقي)";
  return "ألصق مفتاح API هنا";
}

function statusBadge(status: string) {
  switch (status) {
    case "active":
    case "completed":
      return <Badge className="rounded-full px-3 bg-emerald-500/[0.12] text-emerald-300 border border-emerald-400/25">نشط</Badge>;
    case "exhausted":
      return <Badge className="rounded-full px-3 bg-amber-500/[0.12] text-amber-300 border border-amber-400/25">مستنزف</Badge>;
    case "processing":
    case "pending":
      return <Badge className="rounded-full px-3 bg-[#007AFF]/[0.12] text-[#7CC0FF] border border-[#007AFF]/30">جارية</Badge>;
    case "failed":
      return <Badge className="rounded-full px-3 bg-red-500/[0.12] text-red-300 border border-red-400/25">فاشلة</Badge>;
    case "disabled":
      return <Badge className="rounded-full px-3 bg-white/[0.07] text-white/70 border border-white/[0.12]">معطّل</Badge>;
    default:
      return <Badge className="rounded-full px-3 bg-[#007AFF]/[0.12] text-[#7CC0FF] border border-[#007AFF]/30">{status}</Badge>;
  }
}

function typeName(t: string) {
  return t === "image" ? "صورة" : t === "video" ? "فيديو" : "دمج";
}

function fmtDate(s: string) {
  if (!s) return "";
  return s.replace("T", " ").slice(0, 16);
}

async function copyText(text: string, okMsg: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMsg);
  } catch {
    toast.error("تعذر النسخ — انسخ يدويًا من الحقل.");
  }
}

// ---------------------------------------------------------------------------

export default function Dashboard() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [healthOffline, setHealthOffline] = useState(false);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [tasksData, setTasksData] = useState<TasksResponse | null>(null);
  const [mcpUrl, setMcpUrl] = useState("");
  const [busy, setBusy] = useState(false);

  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      const j = (await r.json()) as HealthInfo;
      setHealth(j);
      setHealthOffline(false);
    } catch {
      // فشل الشبكة نفسها — يظهر في الشارة كحالة فحص/انقطاع مع سبب في صندوق التشخيص أدناه
      setHealth(null);
      setHealthOffline(true);
    }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys", { cache: "no-store" });
      const j = (await r.json()) as { keys: KeyItem[] };
      setKeys(j.keys ?? []);
    } catch {
      /* تجاهل */
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const j = (await r.json()) as TasksResponse;
      setTasksData(j);
    } catch {
      /* تجاهل */
    }
  }, []);

  useEffect(() => {
    // الرابط والتحميل الأولي داخل مؤقت — تفاديًا لضبط الحالة تزامنيًا داخل الإفكت
    const t0 = setTimeout(() => {
      setMcpUrl(`${window.location.origin}/mcp`);
      void loadHealth();
      void loadKeys();
      void loadTasks();
    }, 0);
    const t1 = setInterval(() => void loadTasks(), 5000); // لوحة المهام تتحدث كل 5 ثوانٍ
    const t2 = setInterval(() => void loadHealth(), 30000);
    return () => {
      clearTimeout(t0);
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [loadHealth, loadKeys, loadTasks]);

  async function addKey() {
    if (!apiKey.trim()) {
      toast.error("أدخل المفتاح أولًا.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      // قراءة آمنة للاستجابة: JSON متوقع، لكن أي جسم آخر (مثل صفحة خطأ 5xx) لا يُخفي السبب
      const text = await r.text();
      let j: { error?: string; detail?: string } = {};
      try {
        j = JSON.parse(text) as { error?: string; detail?: string };
      } catch {
        j = { error: `استجابة غير متوقعة من الخادم (HTTP ${r.status}).` };
      }
      if (!r.ok) {
        const base = j.error ?? "فشل إضافة المفتاح.";
        toast.error(j.detail ? base + "\n" + j.detail : base, { duration: 8000 });
      } else {
        toast.success("أُضيف المفتاح — سيُجرَّب أولًا حسب ترتيب الإضافة.");
        setApiKey("");
        setLabel("");
        await loadKeys();
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      toast.error(`تعذر الاتصال بالخادم — تحقق من الشبكة. (${reason})`, { duration: 8000 });
    } finally {
      setBusy(false);
    }
  }

  async function toggleKey(k: KeyItem) {
    setBusy(true);
    try {
      const r = await fetch(`/api/keys/${k.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: k.status === "disabled" ? "enable" : "disable" }),
      });
      if (!r.ok) {
        const j = (await r.json()) as { error?: string };
        toast.error(j.error ?? "فشل تغيير الحالة.");
      } else {
        await loadKeys();
      }
    } finally {
      setBusy(false);
    }
  }

  async function deleteKey(k: KeyItem) {
    setBusy(true);
    try {
      const r = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = (await r.json()) as { error?: string };
        toast.error(j.error ?? "فشل الحذف.");
      } else {
        toast.success("حُذف المفتاح.");
        await loadKeys();
      }
    } finally {
      setBusy(false);
    }
  }

  const authHeaders = health?.authRequired
    ? `,\n        "headers": {\n          "Authorization": "Bearer <MCP_ACCESS_TOKEN>"\n        }`
    : "";
  const chatgptJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authHeaders}\n    }\n  }\n}`;
  const claudeJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${authHeaders}\n    }\n  }\n}`;
  const cursorJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authHeaders}\n    }\n  }\n}`;

  const stats = tasksData?.stats ?? { total: 0, completed: 0, failed: 0, processing: 0 };

  return (
    <div className="min-h-screen flex flex-col relative bg-[#050507] text-white overflow-x-clip">
      {/* إضاءة محيطية ناعمة على طراز macOS */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute -top-48 left-1/2 -translate-x-1/2 h-[440px] w-[760px] rounded-full bg-[#007AFF]/[0.13] blur-[150px]" />
        <div className="absolute bottom-[-200px] end-[-140px] h-[400px] w-[540px] rounded-full bg-[#5E5CE6]/[0.10] blur-[160px]" />
        <div className="absolute top-[30%] start-[-160px] h-[340px] w-[440px] rounded-full bg-[#30D158]/[0.05] blur-[150px]" />
      </div>
      <Toaster position="top-center" richColors />
      {/* ===================== الهيدر ===================== */}
      <header className="border-b border-white/[0.07] bg-[#050507]/60 backdrop-blur-2xl sticky top-0 z-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3.5 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 me-auto">
            <div className="size-11 rounded-[14px] bg-gradient-to-b from-[#0A84FF] to-[#0060DF] grid place-items-center text-white font-bold text-lg shadow-lg shadow-[#007AFF]/30 ring-1 ring-inset ring-white/25">
              M
            </div>
            <div>
              <h1 className="text-[17px] font-semibold tracking-tight leading-tight text-white">Meko — مولد الوسائط الذكي</h1>
              <p className="text-[13px] text-white/60">خادم MCP لتوليد الصور والفيديو ودمج المقاطع</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {health === null ? (
              healthOffline ? (
                <Badge className="rounded-full px-3 bg-red-500/[0.12] text-red-300 border border-red-400/25">غير متصل</Badge>
              ) : (
                <Badge className="rounded-full px-3 bg-white/[0.07] text-white/70 border border-white/[0.12]">جارٍ الفحص…</Badge>
              )
            ) : health.ok ? (
              <Badge className="rounded-full px-3 bg-emerald-500/[0.12] text-emerald-300 border border-emerald-400/25">Turso متصل</Badge>
            ) : (
              <Badge className="rounded-full px-3 bg-red-500/[0.12] text-red-300 border border-red-400/25">غير متصل</Badge>
            )}
            {health?.merger && (
              <Badge
                className={
                  health.merger.healthy
                    ? "rounded-full px-3 bg-emerald-500/[0.12] text-emerald-300 border border-emerald-400/25"
                    : "rounded-full px-3 bg-amber-500/[0.12] text-amber-300 border border-amber-400/25"
                }
              >
                {health.merger.healthy ? "خدمة الدمج جاهزة" : "خدمة الدمج غير مهيأة"}
              </Badge>
            )}
            {health?.authRequired && (
              <Badge className="rounded-full px-3 bg-[#007AFF]/[0.12] text-[#7CC0FF] border border-[#007AFF]/30">محمي بـ Token</Badge>
            )}
          </div>
        </div>
      </header>

      {/* ===================== المحتوى ===================== */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6 py-6 sm:py-8 space-y-5 sm:space-y-6">

        {/* تشخيص فشل الاتصال — يعرض السبب الحقيقي من الخادم بدل رسالة صامتة */}
        {health && !health.ok && (
          <div className="rounded-2xl border border-red-400/25 bg-red-500/[0.08] p-4 text-[13px] leading-relaxed text-red-200">
            <p className="font-semibold mb-1.5">تعذر الاتصال بقاعدة بيانات Turso — السبب من الخادم:</p>
            <p dir="auto" className="break-words text-red-200/85">{health.dbError || health.database}</p>
            <p className="mt-2 text-[11px] text-red-200/60">
              تحقق من متغيرات البيئة في Vercel (TURSO_DATABASE_URL و TURSO_AUTH_TOKEN لبيئة Production) ثم أعد النشر.
            </p>
          </div>
        )}
        <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2 items-start">
          {/* ---------- أ) مدير المفاتيح ---------- */}
          <Card className="glass-card rounded-3xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2.5 text-[17px] tracking-tight text-white">
                <span className="size-2.5 rounded-full bg-[#0A84FF] shadow-[0_0_10px_rgba(10,132,255,0.7)]" />
                مدير المفاتيح
              </CardTitle>
              <CardDescription className="leading-relaxed">
                أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند
                أي خطأ أو نفاد رصيد دون توقف.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[auto_1fr]">
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger className="w-full sm:w-[150px] h-11 rounded-xl bg-white/[0.05] border-white/[0.12] text-white transition-smooth">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="kie">kie.ai</SelectItem>
                    <SelectItem value="cometapi">CometAPI</SelectItem>
                    <SelectItem value="cloudflare">Cloudflare AI (مجاني)</SelectItem>
                    <SelectItem value="pollinations">Pollinations (مجاني)</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex gap-2">
                  <Input
                    placeholder="تسمية اختيارية (مثال: مفتاح رئيسي)"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    className="h-11 rounded-xl bg-white/[0.05] border-white/[0.12] text-white transition-smooth"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder={keyInputPlaceholder(provider)}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="h-11 rounded-xl bg-white/[0.05] border-white/[0.12] text-white font-mono text-left transition-smooth"
                  dir="ltr"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void addKey();
                  }}
                />
                <Button onClick={() => void addKey()} disabled={busy} className="h-11 rounded-full px-6 bg-[#007AFF] hover:bg-[#0071E3] text-white font-semibold shadow-[0_6px_18px_rgba(0,122,255,0.35)] transition-smooth disabled:opacity-50">
                  إضافة
                </Button>
              </div>
              {providerHint(provider)}

              <div className="max-h-96 overflow-y-auto pe-1">
                {keys.length === 0 ? (
                  <p className="p-6 text-sm text-white/55 text-center">لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لبدء التوليد.</p>
                ) : (
                  <ul className="space-y-2">
                    {keys.map((k, i) => (
                      <li key={k.id} className="glass-row rounded-2xl p-3.5 space-y-2 transition-smooth">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs text-white/40 font-mono">#{i + 1}</span>
                          <Badge variant="outline" className="rounded-full border-white/[0.14] text-white/80">
                            {PROVIDER_LABELS[k.provider] ?? k.provider}
                          </Badge>
                          <code className="font-mono text-xs text-white/75" dir="ltr">
                            {k.masked}
                          </code>
                          {statusBadge(k.status)}
                          {k.label && <span className="text-xs text-white/60">{k.label}</span>}
                          <div className="ms-auto flex gap-1.5">
                            <Button size="sm" variant="outline" className="h-8 px-3.5 text-xs rounded-full border-white/[0.14] bg-white/[0.06] text-white hover:bg-white/[0.12]" onClick={() => void toggleKey(k)}>
                              {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                            </Button>
                            <Button size="sm" variant="outline" className="h-8 px-3.5 text-xs rounded-full border-red-400/25 bg-red-500/[0.08] text-red-300 hover:bg-red-500/[0.16]" onClick={() => void deleteKey(k)}>
                              حذف
                            </Button>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/60">
                          <span>استخدام: {k.usage_count}</span>
                          <span className="text-emerald-400">نجاح: {k.success_count}</span>
                          <span className="text-red-400">فشل: {k.fail_count}</span>
                          {k.last_used_at && <span>آخر استخدام: {fmtDate(k.last_used_at)}</span>}
                        </div>
                        {k.last_error && (
                          <p className="text-[11px] text-red-300/80 truncate" title={k.last_error}>
                            آخر خطأ: {k.last_error}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ---------- ب) لوحة المهام ---------- */}
          <Card className="glass-card rounded-3xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2.5 text-[17px] tracking-tight text-white">
                <span className="size-2.5 rounded-full bg-[#BF5AF2] shadow-[0_0_10px_rgba(191,90,242,0.7)]" />
                لوحة المهام
              </CardTitle>
              <CardDescription>تتحدث تلقائيًا كل 5 ثوانٍ</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <StatChip label="الإجمالي" value={stats.total} cls="text-white" />
                <StatChip label="مكتملة" value={stats.completed} cls="text-[#30D158]" />
                <StatChip label="فاشلة" value={stats.failed} cls="text-[#FF453A]" />
                <StatChip label="جارية" value={stats.processing} cls="text-[#0A84FF]" />
              </div>

              <div className="max-h-96 overflow-y-auto pe-1">
                {!tasksData || tasksData.tasks.length === 0 ? (
                  <p className="p-6 text-sm text-white/55 text-center">لا توجد مهام بعد — ابدأ التوليد من أي عميل MCP.</p>
                ) : (
                  <ul className="space-y-2">
                    {tasksData.tasks.map((t) => (
                      <li key={t.id} className="glass-row rounded-2xl p-3.5 space-y-2 transition-smooth">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="rounded-full border-white/[0.14] text-white/80">
                            {typeName(t.type)}
                          </Badge>
                          {statusBadge(t.status)}
                          <code className="font-mono text-[10px] text-white/45" dir="ltr">
                            {t.model}
                          </code>
                          {t.attempts > 1 && (
                            <Badge variant="outline" className="rounded-full border-amber-400/30 text-amber-300 text-[10px]">
                              محاولات: {t.attempts}
                            </Badge>
                          )}
                          <span className="ms-auto text-[11px] text-white/45">{fmtDate(t.created_at)}</span>
                        </div>
                        {t.prompt && <p className="text-xs text-white/75 truncate" title={t.prompt}>{t.prompt}</p>}
                        {t.status === "processing" && <Progress value={t.progress} className="h-1.5 bg-white/[0.10]" />}
                        {t.status === "completed" && t.urls.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {t.urls.map((u, i) => (
                              <a key={i} href={u} target="_blank" rel="noreferrer">
                                <Button size="sm" variant="outline" className="h-8 px-3.5 text-xs rounded-full border-[#007AFF]/35 bg-[#007AFF]/[0.10] text-[#7CC0FF] hover:bg-[#007AFF]/[0.22]">
                                  فتح النتيجة {t.urls.length > 1 ? `#${i + 1}` : ""}
                                </Button>
                              </a>
                            ))}
                          </div>
                        )}
                        {t.status === "failed" && t.error && (
                          <p className="text-[11px] text-red-300/90">{t.error}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ---------- ج) ربط السيرفر ---------- */}
        <Card className="glass-card rounded-3xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2.5 text-[17px] tracking-tight text-white">
              <span className="size-2.5 rounded-full bg-[#30D158] shadow-[0_0_10px_rgba(48,209,88,0.7)]" />
              ربط السيرفر بأي عميل MCP
            </CardTitle>
            <CardDescription>انسخ الرابط أو صيغة الإعداد المناسبة لعميلك</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input readOnly value={mcpUrl} dir="ltr" className="h-11 rounded-xl bg-white/[0.05] border-white/[0.12] text-white font-mono text-left transition-smooth" />
              <Button onClick={() => void copyText(mcpUrl, "نُسخ رابط MCP")} className="h-11 rounded-full px-6 bg-[#007AFF] hover:bg-[#0071E3] text-white font-semibold shadow-[0_6px_18px_rgba(0,122,255,0.35)] transition-smooth">
                نسخ
              </Button>
            </div>

            <Tabs defaultValue="chatgpt">
              <TabsList className="bg-white/[0.06] border border-white/[0.08] rounded-full p-1 h-auto w-full sm:w-fit">
                <TabsTrigger value="chatgpt" className="rounded-full px-4 sm:px-5 h-9 text-[13px] text-white/65 data-[state=active]:bg-[#007AFF] dark:data-[state=active]:bg-[#007AFF] data-[state=active]:text-white data-[state=active]:border-transparent dark:data-[state=active]:border-transparent data-[state=active]:shadow-[0_2px_12px_rgba(0,122,255,0.45)] transition-smooth">ChatGPT / GPT Agents</TabsTrigger>
                <TabsTrigger value="claude" className="rounded-full px-4 sm:px-5 h-9 text-[13px] text-white/65 data-[state=active]:bg-[#007AFF] dark:data-[state=active]:bg-[#007AFF] data-[state=active]:text-white data-[state=active]:border-transparent dark:data-[state=active]:border-transparent data-[state=active]:shadow-[0_2px_12px_rgba(0,122,255,0.45)] transition-smooth">Claude Desktop</TabsTrigger>
                <TabsTrigger value="cursor" className="rounded-full px-4 sm:px-5 h-9 text-[13px] text-white/65 data-[state=active]:bg-[#007AFF] dark:data-[state=active]:bg-[#007AFF] data-[state=active]:text-white data-[state=active]:border-transparent dark:data-[state=active]:border-transparent data-[state=active]:shadow-[0_2px_12px_rgba(0,122,255,0.45)] transition-smooth">Cursor / Windsurf / Cline</TabsTrigger>
              </TabsList>
              <TabsContent value="chatgpt" className="space-y-2">
                <p className="text-[13px] text-white/60">
                  في ChatGPT: Settings → Connectors → Create → Custom MCP server وضَع الرابط في حقل «Server URL».
                </p>
                <JsonBlock json={chatgptJson} onCopy={() => void copyText(chatgptJson, "نُسخ إعداد ChatGPT")} />
              </TabsContent>
              <TabsContent value="claude" className="space-y-2">
                <p className="text-[13px] text-white/60">الصقها في ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop.</p>
                <JsonBlock json={claudeJson} onCopy={() => void copyText(claudeJson, "نُسخ إعداد Claude")} />
              </TabsContent>
              <TabsContent value="cursor" className="space-y-2">
                <p className="text-[13px] text-white/60">الصقها في mcp.json داخل إعدادات Cursor / Windsurf / Cline.</p>
                <JsonBlock json={cursorJson} onCopy={() => void copyText(cursorJson, "نُسخ إعداد Cursor")} />
              </TabsContent>
            </Tabs>

            <div className="flex flex-wrap gap-2.5">
              {TOOLS.map((t) => (
                <div key={t.name} className="glass-row rounded-2xl px-4 py-3 max-w-full transition-smooth">
                  <code className="font-mono text-xs text-[#0A84FF] font-semibold" dir="ltr">
                    {t.name}
                  </code>
                  <p className="text-[11px] text-white/60 mt-1">{t.desc}</p>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-[#FF9F0A]/25 bg-[#FF9F0A]/[0.08] p-4 text-[13px] leading-relaxed text-[#FFD48A]">
              الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال
              المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع
              العملية.
            </div>
          </CardContent>
        </Card>
      </main>

      {/* ===================== الفوتر ===================== */}
      <footer className="mt-auto border-t border-white/[0.06] bg-black/30 backdrop-blur-xl">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-4 text-center text-xs text-white/55">
          Meko MCP Media Generator — روابط فقط، لا تنزيل أي وسائط على السيرفر — التبديل التسلسلي للمفاتيح صامت تمامًا
          أمام نموذج الذكاء الاصطناعي.
        </div>
      </footer>
    </div>
  );
}

function StatChip({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className="glass-row rounded-2xl p-3.5 text-center transition-smooth">
      <div className={`text-2xl font-bold tracking-tight ${cls}`}>{value}</div>
      <div className="text-[11px] text-white/55 mt-0.5">{label}</div>
    </div>
  );
}

function JsonBlock({ json, onCopy }: { json: string; onCopy: () => void }) {
  return (
    <div className="relative rounded-2xl border border-white/[0.08] bg-black/50 overflow-hidden">
      <pre dir="ltr" className="overflow-x-auto p-4 text-left font-mono text-xs text-[#7EE8A2]/90">
        {json}
      </pre>
      <Button
        size="sm"
        variant="outline"
        className="absolute top-2.5 end-2.5 h-8 px-3.5 text-xs rounded-full border-white/[0.14] bg-white/[0.08] text-white hover:bg-white/[0.16] backdrop-blur-xl"
        onClick={onCopy}
      >
        نسخ
      </Button>
    </div>
  );
}
