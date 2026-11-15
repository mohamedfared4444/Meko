import type { ProviderId } from "../types";

/** شكل روابط النتائج المعاد من checkTask */
export interface ProviderCheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

/**
 * واجهة المزودات — كل مزود ينفذها:
 * - createTask: مهمة غير متزامنة (فيديو وبعض الصور) تعيد providerTaskId
 * - createImageSync: صور متزامنة إن كان المزود يدعمها (CometAPI يعيد النتيجة فورًا)
 * - checkTask: استعلام حالة مهمة جارية
 */
export interface ProviderAdapter {
  createTask(key: string, providerModel: string, input: Record<string, unknown>): Promise<{ providerTaskId: string }>;
  createImageSync?(key: string, providerModel: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  checkTask(key: string, providerModel: string, providerTaskId: string): Promise<ProviderCheckResult>;
}

/** خطأ HTTP خام من أي مزود (يُستخدم داخل المزودات) */
export class ProviderHttpError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}
