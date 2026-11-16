"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import NewTaskModal from "@/components/new-task-modal";

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

/** تفاصيل الخطوات الحية — تأتي من /api/tasks لكل مهمة */
interface TaskDetail {
  stage: string | null;
  scenesTotal: number | null;
  scenesDone: number | null;
  hasAudio: boolean;
  audioUrl: string | null;
  currentProvider: string | null;
  lastNote: string | null;
  /** حزمة النشر الجاهزة (عناوين + وصف + هاشتاغات) — من params_json.seoPack */
  seo: { titles: string[]; description: string; hashtags: string[] } | null;
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
  updated_at: string;
  detail: TaskDetail;
}

interface TasksResponse {
  stats: { total: number; completed: number; failed: number; processing: number };
  meta?: { advanced: number; timedOut: number };
  tasks: TaskItem[];
  error?: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// ثوابت العرض

/** خط إنتاج الفيديو الكامل — يعرض متتبع مراحل خاص */
const FULL_VIDEO_MODEL = "full-video-pipeline";
/** الفيديو البرمجي (render_code_video) — متتبع مراحل خاص أيضًا */
const CODE_VIDEO_MODEL = "code-video-pipeline";

const PROVIDER_LABELS: Record<string, string> = {
  cloudflare: "Cloudflare",
  huggingface: "Hugging Face",
  gemini: "Gemini",
  pollinations: "Pollinations",
  kie: "KIE.ai",
  cometapi: "CometAPI",
};

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  exhausted: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  disabled: "bg-red-500/15 text-red-400 border-red-500/30",
};

const STATUS_LABELS: Record<string, string> = {
  active: "نشط",
  exhausted: "مستنزف",
  disabled: "معطّل",
};

/** مراحل خط إنتاج الفيديو الكامل — بالترتيب مع تسمياتها */
const PIPELINE_STAGES: Array<{ id: string; label: string }> = [
  { id: "script", label: "السكربت والمشاهد" },
  { id: "audio", label: "التعليق الصوتي" },
  { id: "images", label: "صور المشاهد" },
  { id: "merge", label: "دمج الفيديو" },
];

/** مراحل الفيديو البرمجي — صوت اختياري ثم رندر الإطارات */
const CODE_VIDEO_STAGES: Array<{ id: string; label: string }> = [
  { id: "audio", label: "التعليق الصوتي" },
  { id: "render", label: "رندر الإطارات" },
];

// ---------------------------------------------------------------------------
// أدوات عرض صغيرة

function sinceText(iso: string): string {
  const t = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + (iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso) ? "" : "Z"));
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 5) return "الآن";
  if (s < 60) return `منذ ${s} ثانية`;
  const m = Math.floor(s / 60);
  if (m < 60) return `منذ ${m} دقيقة${m === 1 ? "" : m === 2 ? "" : ""}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `منذ ${h} ساعة`;
  const d = Math.floor(h / 24);
  return `منذ ${d} يوم`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** هل الرابط قابل للعرض/التحميل مباشرة (data URLs طويلة جدًا للعرض كرابط) */
function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

function modelLabel(model: string): string {
  if (model === FULL_VIDEO_MODEL) return "خط إنتاج فيديو كامل";
  if (model === CODE_VIDEO_MODEL) return "فيديو أنيميشن برمجي";
  return model;
}

// ---------------------------------------------------------------------------
// اللوحة الرئيسية

export default function Dashboard() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [stats, setStats] = useState<TasksResponse["stats"] | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [isLiveSyncing, setIsLiveSyncing] = useState(false);

  // مراجع حماية التدفق: طلب واحد قيد الطيران للواجهة، وإيقاف التحديث عند التفريغ
  const tasksFetching = useRef(false);
  const mounted = useRef(true);

  const loadTasks = useCallback(async () => {
    if (tasksFetching.current || typeof document === "undefined") return;
    if (document.hidden) return; // التبويب في الخلفية — لا استدعاءات عبثية
    tasksFetching.current = true;
    setIsLiveSyncing(true);
    try {
      const r = await fetch("/api/tasks?limit=50", { cache: "no-store" });
      const j = (await r.json()) as TasksResponse;
      if (!mounted.current) return;
      if (j.error) {
        setTasksError(j.error);
        return;
      }
      setTasksError(null);
      setStats(j.stats);
      setTasks(j.tasks);
    } catch {
      if (mounted.current) setTasksError("تعذر الاتصال بالخادم — يعاد المحاولة تلقائيًا كل 5 ثوانٍ.");
    } finally {
      tasksFetching.current = false;
      if (mounted.current) setIsLiveSyncing(false);
    }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys", { cache: "no-store" });
      const j = (await r.json()) as { keys: KeyItem[] };
      if (mounted.current) setKeys(j.keys ?? []);
    } catch {
      /* صامت — القائمة تُجلب مجددًا في الدورة التالية */
    }
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      const j = (await r.json()) as HealthInfo;
      if (mounted.current) setHealth(j);
    } catch {
      /* صامت */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadHealth();
    void loadKeys();
    void loadTasks();
    const tasksTimer = setInterval(() => void loadTasks(), 5000);
    const keysTimer = setInterval(() => void loadKeys(), 30000);
    const healthTimer = setInterval(() => void loadHealth(), 60000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      clearInterval(tasksTimer);
      clearInterval(keysTimer);
      clearInterval(healthTimer);
      clearInterval(tick);
    };
  }, [loadTasks, loadKeys, loadHealth]);

  /** بعد نجاح الإطلاق من النافذة المنبثقة: أغلقها واعرض المهمة فورًا في الشاشة المباشرة */
  const handleTaskCreated = useCallback(
    (_taskId: string, kind: "full" | "code") => {
      setNewTaskOpen(false);
      void loadTasks();
      toast.success(kind === "full" ? "بدأ خط إنتاج الفيديو الكامل" : "بدأ رندر الأنيميشن البرمجي");
    },
    [loadTasks],
  );

  // المهمتا الجاريتان للعرض الرئيسي — الأحدث أولًا
  const processing = tasks.filter((t) => t.status === "processing" || t.status === "pending");
  const completed = tasks.filter((t) => t.status === "completed");
  const failed = tasks.filter((t) => t.status === "failed");

  return (
    <div className="min-h-screen flex flex-row bg-background text-foreground">
      <Toaster richColors position="top-center" />
      <NewTaskModal open={newTaskOpen} onOpenChange={setNewTaskOpen} onCreated={handleTaskCreated} />
      {/* الشريط الجانبي — ثابت على الشاشات الكبيرة، Drawer على الموبايل */}
      <aside className="hidden lg:flex w-[400px] shrink-0 flex-col border-e border-white/10 bg-[#0a0b0e]">
        <SidebarContent keys={keys} onKeysChanged={loadKeys} completed={completed} failed={failed} />
      </aside>
      {drawerOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <button aria-label="إغلاق" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
          <div className="relative w-[min(420px,92vw)] h-full flex flex-col bg-[#0a0b0e] border-e border-white/10 shadow-2xl animate-in slide-in-from-right duration-200 overflow-hidden">
            <button
              aria-label="إغلاق القائمة"
              onClick={() => setDrawerOpen(false)}
              className="absolute top-3 start-3 z-10 rounded-full bg-white/10 hover:bg-white/20 w-8 h-8 flex items-center justify-center text-sm"
            >
              ✕
            </button>
            <SidebarContent keys={keys} onKeysChanged={loadKeys} completed={completed} failed={failed} />
          </div>
        </div>
      )}

      {/* المنطقة الرئيسية — العمل الجاري فقط */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-40 border-b border-white/10 bg-[#050507]/85 backdrop-blur-md">
          <div className="mx-auto w-full max-w-4xl px-4 sm:px-6 py-3 flex items-center gap-3">
            <button
              aria-label="فتح القائمة"
              onClick={() => setDrawerOpen(true)}
              className="lg:hidden rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 px-2.5 py-2"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            </button>
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="w-8 h-8 rounded-lg bg-primary/20 text-primary flex items-center justify-center shrink-0">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
                </svg>
              </span>
              <div className="min-w-0">
                <h1 className="text-[15px] font-bold leading-tight truncate">Meko — العمل المباشر</h1>
                <p className="text-[11px] text-muted-foreground leading-tight">
                  {isLiveSyncing && processing.length > 0 ? "جارٍ دفع المهمة للأمام حيًّا…" : "تحديث تلقائي كل 5 ثوانٍ"}
                </p>
              </div>
            </div>
            <div className="ms-auto flex items-center gap-1.5 shrink-0">
              <Button
                onClick={() => setNewTaskOpen(true)}
                className="h-8 gap-1.5 rounded-lg px-3 text-[12px] font-bold shadow-[0_0_16px_rgba(0,122,255,0.3)]"
                title="إطلاق مهمة إنتاج فيديو من الـويب مباشرة"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                مهمة جديدة
              </Button>
              {stats && (
                <span className="hidden md:flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Chip>{processing.length} جارية</Chip>
                  <Chip>{completed.length} مكتملة</Chip>
                  <Chip>{failed.length} فاشلة</Chip>
                </span>
              )}
              <span
                className={`w-2.5 h-2.5 rounded-full shrink-0 ${health?.ok ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" : "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.8)]"}`}
                title={health?.ok ? "قاعدة البيانات متصلة" : (health?.dbError ?? "قاعدة البيانات غير متصلة")}
              />
            </div>
          </div>
        </header>

        <div className="mx-auto w-full max-w-4xl px-4 sm:px-6 py-5 flex-1">
          {tasksError && (
            <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 text-xs px-4 py-3">{tasksError}</div>
          )}

          {processing.length === 0 ? (
            <IdleState mcpEndpoint={health?.mcpEndpoint ?? "/mcp"} />
          ) : (
            <div className="space-y-4">
              {processing.map((t) => (
                <ActiveTaskCard key={t.id} task={t} now={now} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// الشريط الجانبي — أرشيف المهام + إدارة المفاتيح

function SidebarContent({
  keys,
  onKeysChanged,
  completed,
  failed,
}: {
  keys: KeyItem[];
  onKeysChanged: () => void | Promise<void>;
  completed: TaskItem[];
  failed: TaskItem[];
}) {
  const [section, setSection] = useState<"archive" | "keys">("archive");

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 pt-4 pb-3 border-b border-white/10 flex gap-2">
        <SectionTab active={section === "archive"} onClick={() => setSection("archive")}>
          أرشيف المهام
        </SectionTab>
        <SectionTab active={section === "keys"} onClick={() => setSection("keys")}>
          مفاتيح الـ API
        </SectionTab>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0">
        {section === "archive" ? <ArchiveSection completed={completed} failed={failed} /> : <KeysSection keys={keys} onKeysChanged={onKeysChanged} />}
      </div>
    </div>
  );
}

function SectionTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors ${
        active ? "bg-primary text-white" : "bg-white/5 text-muted-foreground hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md bg-white/5 border border-white/10 px-2 py-0.5 text-[11px] text-muted-foreground">{children}</span>;
}

// ---------------------------------------------------------------------------
// المنطقة الرئيسية — بطاقة المهمة الجارية

const STAGE_LABELS: Record<string, string> = {
  script: "كتابة السكربت وتقسيم المشاهد",
  audio: "توليد التعليق الصوتي",
  images: "توليد صور المشاهد",
  merge: "دمج الفيديو النهائي",
  render: "رندر إطارات المشهد بـ Chromium",
};

function ActiveTaskCard({ task, now: _now }: { task: TaskItem; now: number }) {
  const isPipeline = task.model === FULL_VIDEO_MODEL;
  const isCodeVideo = task.model === CODE_VIDEO_MODEL;
  const stages = isCodeVideo ? CODE_VIDEO_STAGES : PIPELINE_STAGES;
  const stageIndex = isPipeline || isCodeVideo ? Math.max(0, stages.findIndex((s) => s.id === (task.detail?.stage ?? stages[0].id))) : -1;
  const provider = task.detail?.currentProvider;

  return (
    <div className="rounded-2xl border border-white/10 bg-card overflow-hidden">
      <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-white/5">
        <div className="flex items-center gap-2 flex-wrap">
          {isPipeline && <Badge className="bg-primary/20 text-primary border-primary/40 hover:bg-primary/20">خط إنتاج فيديو كامل</Badge>}
          {isCodeVideo && <Badge className="bg-primary/20 text-primary border-primary/40 hover:bg-primary/20">رندر برمجي</Badge>}
          <Badge variant="outline" className="bg-white/5 text-muted-foreground border-white/15 hover:bg-white/5">
            {modelLabel(task.model)}
          </Badge>
          <span className="text-[11px] text-muted-foreground font-mono" title={task.id}>
            #{shortId(task.id)}
          </span>
          <span className="text-[11px] text-muted-foreground ms-auto">{sinceText(task.created_at)}</span>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-foreground/90 line-clamp-2" title={task.prompt}>
          {task.prompt || "—"}
        </p>
      </div>

      <div className="px-4 sm:px-5 py-4 space-y-4">
        {/* نسبة التقدم */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[13px] font-semibold">
              {isPipeline && task.detail?.stage ? STAGE_LABELS[task.detail.stage] ?? "قيد العمل" : "قيد العمل"}
            </span>
            <span className="text-[13px] font-bold text-primary tabular-nums">{Math.round(task.progress)}%</span>
          </div>
          <Progress value={task.progress} className="h-2" />
        </div>

        {/* متتبع مراحل خط الإنتاج / الفيديو البرمجي */}
        {(isPipeline || isCodeVideo) && stageIndex >= 0 && (
          <div className="flex items-center gap-1 sm:gap-1.5">
            {stages.map((s, i) => (
              <div key={s.id} className="flex-1 flex flex-col items-center gap-1.5">
                <div
                  className={`w-2.5 h-2.5 rounded-full transition-colors ${
                    i < stageIndex ? "bg-emerald-400" : i === stageIndex ? "bg-primary shadow-[0_0_10px_rgba(0,122,255,0.9)] animate-pulse" : "bg-white/15"
                  }`}
                />
                <span className={`text-[10px] leading-tight text-center ${i === stageIndex ? "text-foreground font-semibold" : "text-muted-foreground"}`}>
                  {s.label}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* تفاصيل الخطوات الحية */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {isCodeVideo && (
            <DetailCell
              label="التعليق الصوتي"
              value={task.detail?.hasAudio ? "جاهز ومتزامن" : "اختياري"}
              accent={task.detail?.hasAudio}
            />
          )}
          {isPipeline && task.detail?.scenesTotal != null && (
            <DetailCell label="صور المشاهد" value={`${task.detail.scenesDone ?? 0} / ${task.detail.scenesTotal}`} accent={task.detail.scenesDone === task.detail.scenesTotal} />
          )}
          {isPipeline && (
            <DetailCell
              label="التعليق الصوتي"
              value={task.detail?.hasAudio ? (task.detail.audioUrl && isHttpUrl(task.detail.audioUrl) ? "جاهز" : "جاهز (مضمّن)") : "قيد التوليد"}
              accent={task.detail?.hasAudio}
            />
          )}
          <DetailCell label="المزود الحالي" value={provider ? PROVIDER_LABELS[provider] ?? provider : "—"} />
          <DetailCell label="المحاولات" value={String(task.attempts)} />
        </div>

        {task.error && (
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300 leading-relaxed line-clamp-2">
            {task.error}
          </div>
        )}
      </div>
    </div>
  );
}

function DetailCell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg bg-white/[0.04] border border-white/5 px-3 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`text-[13px] font-semibold mt-0.5 truncate ${accent ? "text-emerald-400" : ""}`}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// حالة اللاعمل — رسالة هادئة

function IdleState({ mcpEndpoint }: { mcpEndpoint: string }) {
  return (
    <div className="mt-10 sm:mt-16 flex flex-col items-center text-center gap-4">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/25 flex items-center justify-center text-primary">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
        </svg>
      </div>
      <div className="space-y-2">
        <h2 className="text-xl font-bold">النظام جاهز لاستقبال الطلبات</h2>
        <p className="text-sm text-muted-foreground leading-relaxed max-w-md">
          لا توجد مهام جارية الآن. أطلق مهمة بزر «مهمة جديدة» أعلى الشاشة، أو أرسل الطلب عبر عميل MCP (Claude مثلاً) — وستظهر المهمة هنا فورًا وتتقدم وتكتمل تلقائيًا.
        </p>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>نقطة MCP:</span>
        <code className="rounded-md bg-white/5 border border-white/10 px-2 py-1 font-mono text-foreground/80" dir="ltr">
          {mcpEndpoint}
        </code>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// الشريط الجانبي — أرشيف المهام المنتهية

function ArchiveSection({ completed, failed }: { completed: TaskItem[]; failed: TaskItem[] }) {
  if (completed.length === 0 && failed.length === 0) {
    return (
      <div className="text-center text-muted-foreground text-xs py-10 px-2">
        <p>لا توجد مهام منتهية بعد.</p>
        <p className="mt-1">المهام المكتملة والفاشلة تظهر هنا مع روابطها وأسباب الأخطاء.</p>
      </div>
    );
  }
  return (
    <>
      {completed.map((t) => (
        <CompletedCard key={t.id} task={t} />
      ))}
      {failed.map((t) => (
        <FailedCard key={t.id} task={t} />
      ))}
    </>
  );
}

/** زر نسخ صغير — ينسخ نصًا إلى الحافظة مع إشعار */
function CopyButton({ text, label }: { text: string; label?: string }) {
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success("تم النسخ إلى الحافظة");
        } catch {
          toast.error("تعذر النسخ من المتصفح");
        }
      }}
      title={label ?? "نسخ"}
      className="shrink-0 rounded-md border border-white/10 bg-white/5 hover:bg-white/15 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors"
    >
      نسخ
    </button>
  );
}

/** حزمة النشر الجاهزة (SEO) داخل تفاصيل المهمة المكتملة — جاهزة للنسخ */
function SeoPackBlock({ seo }: { seo: NonNullable<TaskDetail["seo"]> }) {
  const hashtagsText = seo.hashtags.join(" ");
  return (
    <div className="rounded-lg border border-primary/25 bg-primary/[0.07] px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] font-bold text-primary">🚀 حزمة النشر الجاهزة (SEO)</span>
      </div>
      <div className="space-y-1">
        {seo.titles.map((t, i) => (
          <div key={i} className="flex items-start gap-1.5">
            <span className="text-[11px] leading-relaxed text-foreground/90 flex-1" dir="auto">
              {i + 1}. {t}
            </span>
            <CopyButton text={t} label="نسخ العنوان" />
          </div>
        ))}
      </div>
      <div className="flex items-start gap-1.5">
        <p className="text-[11px] leading-relaxed text-foreground/80 whitespace-pre-line flex-1 line-clamp-4" dir="auto" title={seo.description}>
          {seo.description}
        </p>
        <CopyButton text={seo.description} label="نسخ الوصف" />
      </div>
      <div className="flex items-start gap-1.5">
        <p className="text-[11px] leading-relaxed text-primary/90 flex-1 break-words" dir="ltr">
          {hashtagsText}
        </p>
        <CopyButton text={hashtagsText} label="نسخ الهاشتاغات" />
      </div>
    </div>
  );
}

function CompletedCard({ task }: { task: TaskItem }) {
  const httpUrls = task.urls.filter(isHttpUrl);
  const embedded = task.urls.length - httpUrls.length;
  return (
    <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-3.5 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
        <span className="text-[12px] font-semibold text-emerald-300 truncate flex-1">{modelLabel(task.model)}</span>
        <span className="text-[10px] text-muted-foreground shrink-0">{sinceText(task.created_at)}</span>
      </div>
      <p className="text-[11px] text-muted-foreground line-clamp-2" title={task.prompt}>
        {task.prompt || "—"}
      </p>
      {task.model === FULL_VIDEO_MODEL && task.detail?.seo && <SeoPackBlock seo={task.detail.seo} />}
      {httpUrls.length > 0 && (
        <div className="space-y-1.5">
          {httpUrls.slice(0, 6).map((u, i) => (
            <a
              key={i}
              href={u}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 py-1.5 text-[11px] text-primary transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <path d="M15 3h6v6" />
                <path d="M10 14 21 3" />
              </svg>
              <span className="truncate font-mono" dir="ltr">
                {u.replace(/^https?:\/\//, "").slice(0, 46)}
              </span>
            </a>
          ))}
        </div>
      )}
      {embedded > 0 && <p className="text-[10px] text-muted-foreground">+ {embedded} نتيجة مضمّنة داخل الاستجابة (data URL)</p>}
      <p className="text-[10px] text-muted-foreground font-mono" title={task.id}>
        #{shortId(task.id)}
      </p>
    </div>
  );
}

function FailedCard({ task }: { task: TaskItem }) {
  return (
    <div className="rounded-xl border border-red-500/25 bg-red-500/[0.06] p-3.5 space-y-2">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
        <span className="text-[12px] font-semibold text-red-300 truncate flex-1">{modelLabel(task.model)}</span>
        <span className="text-[10px] text-muted-foreground shrink-0">{sinceText(task.created_at)}</span>
      </div>
      <p className="text-[11px] text-muted-foreground line-clamp-1" title={task.prompt}>
        {task.prompt || "—"}
      </p>
      <p className="text-[11px] text-red-300/90 leading-relaxed line-clamp-3" title={task.error ?? ""}>
        {task.error || "سبب غير معروف"}
      </p>
      <p className="text-[10px] text-muted-foreground font-mono" title={task.id}>
        #{shortId(task.id)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// الشريط الجانبي — إدارة مفاتيح الـ API

const KEY_PROVIDERS = [
  { id: "cloudflare", label: "Cloudflare", hint: "ACCOUNT_ID:API_TOKEN أو ACCOUNT_ID:EMAIL:GLOBAL_API_KEY" },
  { id: "huggingface", label: "Hugging Face", hint: "hf_…" },
  { id: "gemini", label: "Gemini", hint: "AIza… أو AQ.…" },
  { id: "pollinations", label: "Pollinations", hint: "أي نص مثل free" },
  { id: "kie", label: "KIE.ai", hint: "توكن الحساب" },
  { id: "cometapi", label: "CometAPI", hint: "توكن الحساب" },
];

function KeysSection({ keys, onKeysChanged }: { keys: KeyItem[]; onKeysChanged: () => void | Promise<void> }) {
  const [provider, setProvider] = useState<string>("cloudflare");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!apiKey.trim()) {
      toast.error("الصق المفتاح أولًا");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) {
        toast.error(j.error ?? "تعذر حفظ المفتاح");
        return;
      }
      toast.success("تمت إضافة المفتاح وتنشيطه");
      setApiKey("");
      setLabel("");
      await onKeysChanged();
    } catch {
      toast.error("تعذر الاتصال بالخادم");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (k: KeyItem) => {
    const action = k.status === "active" ? "disable" : "enable";
    try {
      const r = await fetch(`/api/keys/${k.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!r.ok) {
        const j = (await r.json()) as { error?: string };
        toast.error(j.error ?? "تعذر تغيير حالة المفتاح");
        return;
      }
      toast.success(action === "disable" ? "تم تعطيل المفتاح" : "تم تفعيل المفتاح");
      await onKeysChanged();
    } catch {
      toast.error("تعذر الاتصال بالخادم");
    }
  };

  const remove = async (k: KeyItem) => {
    if (!window.confirm(`حذف المفتاح ${k.label || PROVIDER_LABELS[k.provider] || k.provider} نهائيًا؟`)) return;
    try {
      const r = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = (await r.json()) as { error?: string };
        toast.error(j.error ?? "تعذر حذف المفتاح");
        return;
      }
      toast.success("تم حذف المفتاح");
      await onKeysChanged();
    } catch {
      toast.error("تعذر الاتصال بالخادم");
    }
  };

  return (
    <div className="space-y-4">
      {/* إضافة مفتاح */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3.5 space-y-2.5">
        <h3 className="text-[12px] font-bold">إضافة مفتاح جديد</h3>
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger className="w-full h-9 text-[12px] bg-white/5 border-white/15">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KEY_PROVIDERS.map((p) => (
              <SelectItem key={p.id} value={p.id} className="text-[12px]">
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={KEY_PROVIDERS.find((p) => p.id === provider)?.hint}
          className="h-9 text-[12px] font-mono bg-white/5 border-white/15"
          dir="ltr"
        />
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="تسمية اختيارية (مثل: حساب 1)"
          className="h-9 text-[12px] bg-white/5 border-white/15"
        />
        <Button onClick={submit} disabled={saving} className="w-full h-9 text-[12px] font-semibold">
          {saving ? "جارٍ الحفظ…" : "إضافة وتفعيل"}
        </Button>
      </div>

      {/* القائمة */}
      {keys.length === 0 ? (
        <p className="text-center text-muted-foreground text-xs py-6">لا توجد مفاتيح مخزنة بعد.</p>
      ) : (
        <div className="space-y-2.5">
          {keys.map((k) => (
            <div key={k.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[12px] font-bold">{PROVIDER_LABELS[k.provider] ?? k.provider}</span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[k.status] ?? "bg-white/10 text-muted-foreground border-white/20"}`}
                >
                  {STATUS_LABELS[k.status] ?? k.status}
                </span>
                {k.label && <span className="text-[10px] text-muted-foreground truncate max-w-[110px]">{k.label}</span>}
              </div>
              <div className="font-mono text-[10px] text-muted-foreground" dir="ltr">
                {k.masked}
              </div>
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                <span>استخدام: {k.usage_count}</span>
                <span className="text-emerald-400/80">نجاح: {k.success_count}</span>
                <span className="text-red-400/80">فشل: {k.fail_count}</span>
              </div>
              {k.last_error && (
                <p className="text-[10px] text-amber-400/90 line-clamp-2" title={k.last_error}>
                  {k.last_error}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 flex-1 text-[11px] border-white/15 bg-white/5 hover:bg-white/10"
                  onClick={() => void toggle(k)}
                >
                  {k.status === "active" ? "تعطيل" : "تفعيل"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 flex-1 text-[11px] border-red-500/30 text-red-400 bg-red-500/5 hover:bg-red-500/15 hover:text-red-300"
                  onClick={() => void remove(k)}
                >
                  حذف
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
