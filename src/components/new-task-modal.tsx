"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// نافذة «+ مهمة جديدة» — إطلاق المهام من الويب مباشرة بنفس أدوات MCP:
//   تبويب 1: فيديو بالصور (create_full_video)
//   تبويب 2: أنيميشن بالكود (render_code_video)
// البيانات تُرسل إلى POST /api/tasks/create ثم تُغلق النافذة وتظهر المهمة
// فورًا في شاشة العمل المباشر (التحديث كل 5 ثوانٍ يدفعها للأمام تلقائيًا).
// ---------------------------------------------------------------------------

/** أصوات Edge-TTS المدعومة — نسخة واجهة من كتالوج src/lib/tts.ts مع تسميات عربية */
const VOICES: Array<{ id: string; label: string }> = [
  { id: "en-US-AndrewNeural", label: "Andrew — إنجليزي أمريكي (ذكر)" },
  { id: "en-US-AriaNeural", label: "Aria — إنجليزي أمريكي (أنثى)" },
  { id: "en-US-GuyNeural", label: "Guy — إنجليزي أمريكي (ذكر)" },
  { id: "en-US-EmmaNeural", label: "Emma — إنجليزي أمريكي (أنثى)" },
  { id: "en-US-BrianNeural", label: "Brian — إنجليزي أمريكي (ذكر)" },
  { id: "en-GB-RyanNeural", label: "Ryan — إنجليزي بريطاني (ذكر)" },
  { id: "en-GB-SoniaNeural", label: "Sonia — إنجليزي بريطاني (أنثى)" },
  { id: "ar-EG-ShakirNeural", label: "شاكر — عربي مصري (ذكر)" },
  { id: "ar-SA-HamedNeural", label: "حامد — عربي سعودي (ذكر)" },
  { id: "ar-EG-SalmaNeural", label: "سلمى — عربي مصري (أنثى)" },
];

const HTML_CODE_MIN = 100;
/** حد كود المشهد — يتسع لأكواد HTML/SVG كاملة من النماذج ويحمي صفوف Turso */
const HTML_CODE_MAX = 150_000;
const SCENES_MAX = 12;

/** قالب انطلاقة جاهز — يعرّف window.renderAtTime ليُعدّ أو يُستبدل بكود النموذج */
const HTML_TEMPLATE = [
  "<!DOCTYPE html>",
  "<html><head><style>",
  "  html,body{margin:0;width:100%;height:100%;background:#0b1020;overflow:hidden}",
  "</style></head>",
  "<body>",
  '<svg id="scene" width="100%" height="100%" viewBox="0 0 720 1280" xmlns="http://www.w3.org/2000/svg">',
  '  <rect width="720" height="1280" fill="#0b1020"/>',
  '  <circle id="ball" cx="360" cy="400" r="60" fill="#38bdf8"/>',
  '  <text id="line" x="360" y="760" text-anchor="middle" font-size="46" fill="#ffffff" font-family="Cairo, sans-serif">مرحبًا بك في Meko</text>',
  "</svg>",
  "<script>",
  "  // ارسم الحالة الكاملة للمشهد عند اللحظة t — دالة حتمية بلا انتقالات CSS",
  "  // wordTimings (عند وجود تعليق صوتي): [{start, end, text}] بالثواني — للمزامنة مع كل كلمة",
  "  window.renderAtTime = function (t, duration, wordTimings) {",
  "    const p = duration > 0 ? t / duration : 0; // نسبة التقدم 0..1",
  "    const ball = document.getElementById('ball');",
  "    ball.setAttribute('cy', String(400 + p * 400));",
  "    ball.setAttribute('r', String(60 + p * 40));",
  "    const line = document.getElementById('line');",
  "    line.setAttribute('opacity', String(Math.min(1, p * 3)));",
  "  };",
  "</script></body></html>",
].join("\n");

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** حقول تبويب «فيديو بالصور» (create_full_video) */
function FullVideoForm({
  form,
  update,
}: {
  form: FullFormState;
  update: (patch: Partial<FullFormState>) => void;
}) {
  return (
    <div className="space-y-3.5">
      <div className="space-y-1.5">
        <Label className="text-[12px] font-semibold">موضوع الفيديو *</Label>
        <Input
          value={form.topic}
          onChange={(e) => update({ topic: e.target.value })}
          placeholder="مثال: كيف غيّر القهوة العالم، أو قصة أقدم مكتبة في العالم"
          className="h-9 text-[13px] bg-white/5 border-white/15"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-[12px] font-semibold">
          سكربت التعليق الصوتي <span className="text-muted-foreground font-normal">(اختياري — يُستخدم كما هو بلا تأليف)</span>
        </Label>
        <Textarea
          value={form.customScript}
          onChange={(e) => update({ customScript: e.target.value })}
          placeholder="الصق سكربتًا جاهزًا من أي نموذج — يُقرأ حرفيًا في التعليق الصوتي. اتركه فارغًا ليكتبه Gemini حسب الموضوع والمدة."
          className="min-h-[90px] text-[13px] leading-relaxed bg-white/5 border-white/15"
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-[12px] font-semibold">
            مشاهد جاهزة <span className="text-muted-foreground font-normal">(اختياري — كل سطر مشهد)</span>
          </Label>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {form.scenesText.split("\n").filter((s) => s.trim().length > 0).length} / {SCENES_MAX}
          </span>
        </div>
        <Textarea
          value={form.scenesText}
          onChange={(e) => update({ scenesText: e.target.value })}
          placeholder={"برومبت صورة لكل مشهد في سطر مستقل، مثال:\nلقطة سينمائية لحبيبات قهوة تتناثر في ضوء ذهبي\nمقهى عثماني قديم بفوانيس معلقة\nحبوب القهوة تُحمص في مقلاة نحاسية"}
          className="min-h-[90px] text-[13px] leading-relaxed bg-white/5 border-white/15"
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="space-y-1.5">
          <Label className="text-[12px] font-semibold">المدة (ثانية)</Label>
          <Input
            type="number"
            min={10}
            max={180}
            value={form.duration}
            onChange={(e) => update({ duration: e.target.value })}
            className="h-9 text-[13px] bg-white/5 border-white/15 tabular-nums"
            dir="ltr"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[12px] font-semibold">الاتجاه</Label>
          <Select value={form.aspectRatio} onValueChange={(v) => update({ aspectRatio: v as FullFormState["aspectRatio"] })}>
            <SelectTrigger className="w-full h-9 text-[12px] bg-white/5 border-white/15">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="9:16" className="text-[12px]">9:16 — شورتس/ريلز</SelectItem>
              <SelectItem value="16:9" className="text-[12px]">16:9 — يوتيوب</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-[12px] font-semibold">اللغة</Label>
          <Select value={form.language} onValueChange={(v) => update({ language: v as FullFormState["language"] })}>
            <SelectTrigger className="w-full h-9 text-[12px] bg-white/5 border-white/15">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en" className="text-[12px]">English</SelectItem>
              <SelectItem value="ar" className="text-[12px]">العربية</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-[12px] font-semibold">الصوت</Label>
          <Select value={form.voice} onValueChange={(v) => update({ voice: v })}>
            <SelectTrigger className="w-full h-9 text-[12px] bg-white/5 border-white/15">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto" className="text-[12px]">افتراضي (حسب اللغة)</SelectItem>
              {VOICES.map((v) => (
                <SelectItem key={v.id} value={v.id} className="text-[12px]">
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 cursor-pointer">
        <span className="space-y-0.5">
          <span className="block text-[12px] font-semibold">ترجمة متزامنة محروقة</span>
          <span className="block text-[10px] text-muted-foreground">توقيتات كل كلمة من Edge-TTS تُحوَّل إلى ترجمة نظيفة تُحرق في الفيديو</span>
        </span>
        <Switch checked={form.captions} onCheckedChange={(v) => update({ captions: v })} />
      </label>
    </div>
  );
}

/** حقول تبويب «أنيميشن بالكود» (render_code_video) */
function CodeVideoForm({
  form,
  update,
}: {
  form: CodeFormState;
  update: (patch: Partial<CodeFormState>) => void;
}) {
  const htmlLen = form.htmlCode.trim().length;
  const htmlValid = htmlLen >= HTML_CODE_MIN && form.htmlCode.includes("renderAtTime");
  return (
    <div className="space-y-3.5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div className="space-y-1.5">
          <Label className="text-[12px] font-semibold">عنوان الفيديو *</Label>
          <Input
            value={form.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder="مثال: كيف تعمل اللقاحات"
            className="h-9 text-[13px] bg-white/5 border-white/15"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[12px] font-semibold">الاتجاه</Label>
          <Select value={form.aspectRatio} onValueChange={(v) => update({ aspectRatio: v as CodeFormState["aspectRatio"] })}>
            <SelectTrigger className="w-full h-9 text-[12px] bg-white/5 border-white/15">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="9:16" className="text-[12px]">9:16 — 720×1280</SelectItem>
              <SelectItem value="16:9" className="text-[12px]">16:9 — 1280×720</SelectItem>
              <SelectItem value="1:1" className="text-[12px]">1:1 — 960×960</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-[12px] font-semibold">
          نص التعليق الصوتي <span className="text-muted-foreground font-normal">(اختياري — عند وجوده تُضبط المدة على الصوت وتتزامن الكلمات)</span>
        </Label>
        <Textarea
          value={form.script}
          onChange={(e) => update({ script: e.target.value })}
          placeholder="اكتب نص التعليق الذي يُنطق عبر Edge-TTS، أو اتركه فارغًا لفيديو صامد على المدة الافتراضية (15 ثانية)."
          className="min-h-[80px] text-[13px] leading-relaxed bg-white/5 border-white/15"
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <Label className="text-[12px] font-semibold">كود الأنيميشن (HTML5/SVG) *</Label>
          <div className="flex items-center gap-2">
            <span className={`text-[10px] tabular-nums ${htmlValid ? "text-emerald-400" : "text-muted-foreground"}`}>
              {htmlLen.toLocaleString("en")} / {HTML_CODE_MAX.toLocaleString("en")}
            </span>
            <button
              type="button"
              onClick={() => update({ htmlCode: HTML_TEMPLATE })}
              className="rounded-md border border-white/10 bg-white/5 hover:bg-white/15 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors"
            >
              إدراج قالب جاهز
            </button>
          </div>
        </div>
        <Textarea
          value={form.htmlCode}
          onChange={(e) => update({ htmlCode: e.target.value })}
          placeholder="الصق كودًا كاملًا من أي نموذج (DeepSeek مثلاً) — صفحة HTML/CSS/SVG/JS ذاتية الاحتواء تعرّف window.renderAtTime(t, duration, wordTimings) لرسم حالة المشهد في أي لحظة."
          className="min-h-[220px] text-[12px] leading-relaxed bg-[#0a0b0e] border-white/15 font-mono"
          dir="ltr"
          spellCheck={false}
        />
        <p className={`text-[10px] leading-relaxed ${htmlValid ? "text-emerald-400/90" : "text-muted-foreground"}`}>
          {htmlValid
            ? "الكود يعرّف renderAtTime وجاهز للرندر"
            : "شرطا الصحة: 100 حرفًا على الأقل + تعريف window.renderAtTime(t, duration, wordTimings) داخل <script>"}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-[12px] font-semibold">صوت التعليق</Label>
        <Select value={form.voice} onValueChange={(v) => update({ voice: v })}>
          <SelectTrigger className="w-full h-9 text-[12px] bg-white/5 border-white/15">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VOICES.map((v) => (
              <SelectItem key={v.id} value={v.id} className="text-[12px]">
                {v.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

interface FullFormState {
  topic: string;
  customScript: string;
  scenesText: string;
  duration: string;
  aspectRatio: "9:16" | "16:9";
  language: "en" | "ar";
  voice: string;
  captions: boolean;
}

interface CodeFormState {
  title: string;
  script: string;
  htmlCode: string;
  aspectRatio: "9:16" | "16:9" | "1:1";
  voice: string;
}

export default function NewTaskModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** تُستدعى بعد نجاح الإطلاق: أغلق النافذة وأظهر المهمة في الشاشة المباشرة */
  onCreated: (taskId: string, kind: "full" | "code") => void;
}) {
  const [tab, setTab] = useState<"full" | "code">("full");
  const [submitting, setSubmitting] = useState(false);
  /** رسالة خطأ بارزة ثابتة داخل النافذة — لا تختفي حتى يصلح المستخدم الحقل */
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const [full, setFull] = useState<FullFormState>({
    topic: "",
    customScript: "",
    scenesText: "",
    duration: "30",
    aspectRatio: "9:16",
    language: "en",
    voice: "auto",
    captions: true,
  });
  const [code, setCode] = useState<CodeFormState>({
    title: "",
    script: "",
    htmlCode: "",
    aspectRatio: "9:16",
    voice: "en-US-AndrewNeural",
  });

  const updateFull = (patch: Partial<FullFormState>) => {
    setError(null);
    setFull((s) => ({ ...s, ...patch }));
  };
  const updateCode = (patch: Partial<CodeFormState>) => {
    setError(null);
    setCode((s) => ({ ...s, ...patch }));
  };

  /** خطأ بارز داخل النافذة أعلى زر التشغيل (مرئي على الهاتف ولا يختفي تلقائيًا) */
  const showError = useCallback((msg: string) => {
    setError(msg);
  }, []);

  useEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [error]);

  // إعادة النافذة نظيفة عند كل فتح جديد
  useEffect(() => {
    if (!open) setError(null);
  }, [open]);

  const submit = async () => {
    let payload: Record<string, unknown> | null = null;

    if (tab === "full") {
      const topic = full.topic.trim();
      if (!topic) {
        showError("اكتب موضوع الفيديو أولًا.");
        return;
      }
      const scenes = full.scenesText.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
      if (scenes.length > SCENES_MAX) {
        showError(`الحد الأقصى ${SCENES_MAX} مشهدًا — وصل ${scenes.length}.`);
        return;
      }
      payload = {
        kind: "full",
        topic,
        // الحقول الاختيارية الفارغة تُحذف تمامًا (تصبح undefined في الخادم)
        ...(full.customScript.trim() ? { custom_script: full.customScript.trim() } : {}),
        ...(scenes.length > 0 ? { scenes } : {}),
        duration_seconds: clampInt(full.duration, 10, 180, 30),
        aspect_ratio: full.aspectRatio,
        language: full.language,
        ...(full.voice !== "auto" ? { voice: full.voice } : {}),
        captions: full.captions,
      };
    } else {
      const title = code.title.trim();
      if (!title) {
        showError("اكتب عنوان الفيديو أولًا.");
        return;
      }
      const html = code.htmlCode.trim();
      if (html.length < HTML_CODE_MIN) {
        showError(`كود الأنيميشن قصير جدًا (${html.length} حرفًا) — الصق صفحة HTML كاملة أو أدرج القالب الجاهز.`);
        return;
      }
      if (html.length > HTML_CODE_MAX) {
        showError(`كود الأنيميشن طويل جدًا (${html.length.toLocaleString("en")} حرفًا) — الحد ${HTML_CODE_MAX.toLocaleString("en")} حرفًا.`);
        return;
      }
      if (!html.includes("renderAtTime")) {
        showError("الكود لا يعرّف window.renderAtTime(t, duration, wordTimings) — أضفها داخل <script> أو أدرج القالب الجاهز.");
        return;
      }
      const script = code.script.trim();
      if (script.length > 6000) {
        showError("نص التعليق الصوتي طويل جدًا — الحد 6000 حرفًا.");
        return;
      }
      payload = {
        kind: "code",
        title,
        html_code: html,
        // النص الفارغ يُحذف تمامًا → undefined في الخادم (فيديو صامد على المدة الافتراضية)
        ...(script ? { script } : {}),
        aspect_ratio: code.aspectRatio,
        voice: code.voice,
      };
    }

    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/tasks/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = (await r.json()) as { ok?: boolean; task_id?: string; error?: string };
      if (!r.ok || !j.ok) {
        // رسالة الخطأ من التحقق أو الخادم — بارزة وثابتة داخل النافذة نفسها
        showError(j.error ?? "فشل إطلاق المهمة — حاول مرة أخرى.");
        return;
      }
      toast.success("تم إطلاق المهمة — تتابع تقدمها الآن في شاشة العمل المباشرة");
      onCreated(j.task_id ?? "", tab);
    } catch {
      showError("تعذر الاتصال بالخادم — تحقق من الشبكة ثم أعد المحاولة.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto bg-[#0a0b0e] border-white/15" dir="rtl">
        <DialogHeader className="text-start">
          <DialogTitle className="text-[16px] font-bold">مهمة جديدة</DialogTitle>
          <DialogDescription className="text-[12px] leading-relaxed">
            أطلق مهمة إنتاج فيديو من الـويب مباشرة — انسخ السكربت أو كود الأنيميشن من أي نموذج والصقه هنا، والمهمة تظهر فورًا في شاشة العمل المباشر.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => {
          setError(null);
          setTab(v as "full" | "code");
        }} className="gap-3">
          <TabsList className="grid grid-cols-2 w-full h-9 bg-white/5 border border-white/10">
            <TabsTrigger value="full" className="text-[12px] font-semibold data-[state=active]:bg-primary data-[state=active]:text-white">
              فيديو بالصور
            </TabsTrigger>
            <TabsTrigger value="code" className="text-[12px] font-semibold data-[state=active]:bg-primary data-[state=active]:text-white">
              أنيميشن بالكود
            </TabsTrigger>
          </TabsList>

          <TabsContent value="full">
            <FullVideoForm form={full} update={updateFull} />
          </TabsContent>
          <TabsContent value="code">
            <CodeVideoForm form={code} update={updateCode} />
          </TabsContent>
        </Tabs>

        {error && (
          <div
            ref={errorRef}
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3.5 py-3 text-[12px] font-semibold leading-relaxed text-red-300"
          >
            <svg className="mt-0.5 shrink-0" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
            <span className="whitespace-pre-line">{error}</span>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button
            onClick={() => void submit()}
            disabled={submitting}
            className="flex-1 h-10 text-[13px] font-bold shadow-[0_0_16px_rgba(0,122,255,0.3)]"
          >
            {submitting ? "جارٍ الإطلاق…" : tab === "full" ? "إطلاق خط الإنتاج الكامل" : "إطلاق رندر الأنيميشن"}
          </Button>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="h-10 text-[13px] border-white/15 bg-white/5 hover:bg-white/10"
          >
            إلغاء
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
