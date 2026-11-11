/**
 * أنواع مشتركة للمشروع كله — MCP Media Generator
 */

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type KeyStatus = "active" | "exhausted" | "disabled";

/** تعريف موديل في السجل */
export interface ModelDef {
  /** الاسم كما يراه عميل MCP */
  canonical: string;
  /** صيغ بديلة نقبلها ونوحدّها (شرطات/نقاط) */
  aliases: string[];
  type: MediaType;
  /** المزودون القادرون على خدمته — تُجرَّب مفاتيحهم كلها بالترتيب */
  providers: ProviderId[];
  /** اسم الموديل كما يُرسَل لكل مزود (قابل للتجاوز بمتغيرات البيئة) */
  providerModel: Record<ProviderId, string>;
  /** هل يحتاج موديل معرّف مهمة سابقة (مثل segment-edit)؟ */
  requiresImageTaskId?: boolean;
}

/** صف مهمة في قاعدة البيانات */
export interface TaskRow {
  id: string;
  provider: TaskProvider | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: MediaType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** محاولة مضافة إلى سجل المحاولات */
export interface AttemptRecord {
  provider: TaskProvider;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass: ErrorClass | null;
  error: string | null;
  at: string;
}

/** صف مفتاح API */
export interface ApiKeyRow {
  id: string;
  provider: ProviderId;
  label: string;
  api_key: string;
  status: KeyStatus;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

/** خطأ يرميه أي مزود — يُصنَّف لاحقًا في classifyProviderError */
export class ProviderError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}
