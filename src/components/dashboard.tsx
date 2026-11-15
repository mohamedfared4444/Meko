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
  { name: "generate_image", desc: "توليد صورة من وصف نصي عبر gpt-image-2-6/flare-text-to-image" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي عبر grok-imagine-video-1-5-preview" },
  { name: "merge_videos", desc: "دمج عدة مقاطع فيديو في مقطع واحد بالترتيب المطلوب" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال وعرض الروابط" },
  { name: "list_media", desc: "استرجاع أحدث الصور والفيديوهات المخزنة بروابطها" },
];

function statusBadge(status: string) {
  switch (status) {
    case "active":
    case "completed":
      return <Badge className="bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">نشط</Badge>;
    case "exhausted":
      return <Badge className="bg-amber-500/15 text-amber-300 border border-amber-500/30">مستنزف</Badge>;
    case "processing":
    case "pending":
      return <Badge className="bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">جارية</Badge>;
    case "failed":
      return <Badge className="bg-red-500/15 text-red-300 border border-red-500/30">فاشلة</Badge>;
    case "disabled":
      return <Badge className="bg-slate-500/15 text-slate-300 border border-slate-500/30">معطّل</Badge>;
    default:
      return <Badge>{status}</Badge>;
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
    } catch {
      setHealth(null);
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
      const j = (await r.json()) as { error?: string };
      if (!r.ok) {
        toast.error(j.error ?? "فشل إضافة المفتاح.");
      } else {
        toast.success("أُضيف المفتاح — سيُجرَّب أولًا حسب ترتيب الإضافة.");
        setApiKey("");
        setLabel("");
        await loadKeys();
      }
    } catch {
      toast.error("تعذر الاتصال بالخادم.");
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
    <div className="min-h-screen flex flex-col bg-[radial-gradient(ellipse_at_top,rgba(34,211,238,0.08),transparent_55%),radial-gradient(ellipse_at_bottom,rgba(139,92,246,0.07),transparent_55%)]">
      <Toaster position="top-center" richColors />
      {/* ===================== الهيدر ===================== */}
      <header className="border-b border-slate-800/80 bg-slate-950/70 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-4 py-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 me-auto">
            <div className="size-10 rounded-xl bg-gradient-to-br from-cyan-400 to-violet-500 grid place-items-center text-slate-950 font-extrabold text-lg">
              M
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">Meko — مولد الوسائط الذكي</h1>
              <p className="text-xs text-slate-400">خادم MCP لتوليد الصور والفيديو ودمج المقاطع</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {health === null ? (
              <Badge className="bg-slate-500/15 text-slate-300 border border-slate-500/30">جارٍ الفحص…</Badge>
            ) : health.ok ? (
              <Badge className="bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Turso متصل</Badge>
            ) : (
              <Badge className="bg-red-500/15 text-red-300 border border-red-500/30">غير متصل</Badge>
            )}
            {health?.merger && (
              <Badge
                className={
                  health.merger.healthy
                    ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                    : "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                }
              >
                {health.merger.healthy ? "خدمة الدمج جاهزة" : "خدمة الدمج غير مهيأة"}
              </Badge>
            )}
            {health?.authRequired && (
              <Badge className="bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">محمي بـ Token</Badge>
            )}
          </div>
        </div>
      </header>

      {/* ===================== المحتوى ===================== */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 space-y-6">
        <div className="grid gap-6 lg:grid-cols-2 items-start">
          {/* ---------- أ) مدير المفاتيح ---------- */}
          <Card className="border-slate-800 bg-slate-900/60">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-cyan-400" />
                مدير المفاتيح
              </CardTitle>
              <CardDescription className="leading-relaxed">
                أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند
                أي خطأ أو نفاد رصيد دون توقف.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger className="w-full sm:w-[140px] bg-slate-950 border-slate-700">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="kie">kie.ai</SelectItem>
                    <SelectItem value="cometapi">CometAPI</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex gap-2">
                  <Input
                    placeholder="تسمية اختيارية (مثال: مفتاح رئيسي)"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    className="bg-slate-950 border-slate-700"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="ألصق مفتاح API هنا"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="bg-slate-950 border-slate-700 font-mono text-left"
                  dir="ltr"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void addKey();
                  }}
                />
                <Button onClick={() => void addKey()} disabled={busy} className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold">
                  إضافة
                </Button>
              </div>

              <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-800">
                {keys.length === 0 ? (
                  <p className="p-4 text-sm text-slate-400 text-center">لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لبدء التوليد.</p>
                ) : (
                  <ul className="divide-y divide-slate-800">
                    {keys.map((k, i) => (
                      <li key={k.id} className="p-3 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs text-slate-500 font-mono">#{i + 1}</span>
                          <Badge variant="outline" className="border-slate-700 text-slate-300">
                            {k.provider === "kie" ? "kie.ai" : "CometAPI"}
                          </Badge>
                          <code className="font-mono text-xs text-slate-300" dir="ltr">
                            {k.masked}
                          </code>
                          {statusBadge(k.status)}
                          {k.label && <span className="text-xs text-slate-400">{k.label}</span>}
                          <div className="ms-auto flex gap-1">
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs border-slate-700" onClick={() => void toggleKey(k)}>
                              {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs border-red-900 text-red-300 hover:bg-red-950" onClick={() => void deleteKey(k)}>
                              حذف
                            </Button>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
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
          <Card className="border-slate-800 bg-slate-900/60">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-violet-400" />
                لوحة المهام
              </CardTitle>
              <CardDescription>تتحدث تلقائيًا كل 5 ثوانٍ</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-4 gap-2">
                <StatChip label="الإجمالي" value={stats.total} cls="text-slate-200" />
                <StatChip label="مكتملة" value={stats.completed} cls="text-emerald-300" />
                <StatChip label="فاشلة" value={stats.failed} cls="text-red-300" />
                <StatChip label="جارية" value={stats.processing} cls="text-cyan-300" />
              </div>

              <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-800">
                {!tasksData || tasksData.tasks.length === 0 ? (
                  <p className="p-4 text-sm text-slate-400 text-center">لا توجد مهام بعد — ابدأ التوليد من أي عميل MCP.</p>
                ) : (
                  <ul className="divide-y divide-slate-800">
                    {tasksData.tasks.map((t) => (
                      <li key={t.id} className="p-3 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="border-slate-700 text-slate-300">
                            {typeName(t.type)}
                          </Badge>
                          {statusBadge(t.status)}
                          <code className="font-mono text-[10px] text-slate-500" dir="ltr">
                            {t.model}
                          </code>
                          {t.attempts > 1 && (
                            <Badge variant="outline" className="border-amber-500/40 text-amber-300 text-[10px]">
                              محاولات: {t.attempts}
                            </Badge>
                          )}
                          <span className="ms-auto text-[11px] text-slate-500">{fmtDate(t.created_at)}</span>
                        </div>
                        {t.prompt && <p className="text-xs text-slate-300 truncate" title={t.prompt}>{t.prompt}</p>}
                        {t.status === "processing" && <Progress value={t.progress} className="h-1.5 bg-slate-800" />}
                        {t.status === "completed" && t.urls.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {t.urls.map((u, i) => (
                              <a key={i} href={u} target="_blank" rel="noreferrer">
                                <Button size="sm" variant="outline" className="h-7 px-2 text-xs border-cyan-800 text-cyan-300 hover:bg-cyan-950">
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
        <Card className="border-slate-800 bg-slate-900/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-emerald-400" />
              ربط السيرفر بأي عميل MCP
            </CardTitle>
            <CardDescription>انسخ الرابط أو صيغة الإعداد المناسبة لعميلك</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input readOnly value={mcpUrl} dir="ltr" className="bg-slate-950 border-slate-700 font-mono text-left" />
              <Button onClick={() => void copyText(mcpUrl, "نُسخ رابط MCP")} className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold">
                نسخ
              </Button>
            </div>

            <Tabs defaultValue="chatgpt">
              <TabsList className="bg-slate-950 border border-slate-800">
                <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
                <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
                <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
              </TabsList>
              <TabsContent value="chatgpt" className="space-y-2">
                <p className="text-xs text-slate-400">
                  في ChatGPT: Settings → Connectors → Create → Custom MCP server وضَع الرابط في حقل «Server URL».
                </p>
                <JsonBlock json={chatgptJson} onCopy={() => void copyText(chatgptJson, "نُسخ إعداد ChatGPT")} />
              </TabsContent>
              <TabsContent value="claude" className="space-y-2">
                <p className="text-xs text-slate-400">الصقها في ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop.</p>
                <JsonBlock json={claudeJson} onCopy={() => void copyText(claudeJson, "نُسخ إعداد Claude")} />
              </TabsContent>
              <TabsContent value="cursor" className="space-y-2">
                <p className="text-xs text-slate-400">الصقها في mcp.json داخل إعدادات Cursor / Windsurf / Cline.</p>
                <JsonBlock json={cursorJson} onCopy={() => void copyText(cursorJson, "نُسخ إعداد Cursor")} />
              </TabsContent>
            </Tabs>

            <div className="flex flex-wrap gap-2">
              {TOOLS.map((t) => (
                <div key={t.name} className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 max-w-full">
                  <code className="font-mono text-xs text-cyan-300" dir="ltr">
                    {t.name}
                  </code>
                  <p className="text-[11px] text-slate-400 mt-0.5">{t.desc}</p>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
              الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال
              المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع
              العملية.
            </div>
          </CardContent>
        </Card>
      </main>

      {/* ===================== الفوتر ===================== */}
      <footer className="mt-auto border-t border-slate-800/80 bg-slate-950/60">
        <div className="mx-auto max-w-6xl px-4 py-3 text-center text-xs text-slate-500">
          Meko MCP Media Generator — روابط فقط، لا تنزيل أي وسائط على السيرفر — التبديل التسلسلي للمفاتيح صامت تمامًا
          أمام نموذج الذكاء الاصطناعي.
        </div>
      </footer>
    </div>
  );
}

function StatChip({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-center">
      <div className={`text-xl font-extrabold ${cls}`}>{value}</div>
      <div className="text-[11px] text-slate-400">{label}</div>
    </div>
  );
}

function JsonBlock({ json, onCopy }: { json: string; onCopy: () => void }) {
  return (
    <div className="relative rounded-lg border border-slate-800 bg-slate-950">
      <pre dir="ltr" className="overflow-x-auto p-3 text-left font-mono text-xs text-emerald-200/90">
        {json}
      </pre>
      <Button
        size="sm"
        variant="outline"
        className="absolute top-2 end-2 h-7 px-2 text-xs border-slate-700 bg-slate-900"
        onClick={onCopy}
      >
        نسخ
      </Button>
    </div>
  );
}
