import { http, type RequestOptions } from './client.ts';

/** 巡检扫描参数。 */
export interface ReviewHealthOptions {
  staleDays?: number;
  limit?: number;
}

/** 巡检/建计划请求选项：在通用选项之外可覆盖扫描参数。 */
export interface ReviewRequestOptions extends RequestOptions {
  staleDays?: number;
  limit?: number;
}

/** 单条知识健康线索。 */
export interface HealthFinding {
  id: string;
  severity?: string;
  [key: string]: unknown;
}

/** 巡检汇总统计。 */
export interface ReviewHealthSummary {
  total?: number;
  counts?: Record<string, number>;
  hardTotal?: number;
  candidateTotal?: number;
  warningTotal?: number;
  healthScore?: number;
  [key: string]: unknown;
}

/** 巡检报告：按类别分组的线索集合。 */
export interface ReviewHealthReport {
  noteCount?: number;
  summary?: ReviewHealthSummary;
  categories?: Record<string, HealthFinding[]>;
  [key: string]: unknown;
}

/** 修复计划摘要。 */
export interface ReviewPlanSummary {
  changes?: number;
  deletes?: number;
  manual?: number;
  [key: string]: unknown;
}

/** 修复计划中的单个文件动作。 */
export interface ReviewPlanChange {
  summary?: string;
  [key: string]: unknown;
}

/** 修复计划（POST /review/health/plan）。 */
export interface ReviewPlan {
  id?: string;
  planHash?: string;
  summary?: ReviewPlanSummary;
  changes?: ReviewPlanChange[];
  manual?: unknown[];
  confirmation?: { secondConfirmationRequired?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

/** 修复计划执行结果。 */
export interface ReviewExecuteResult {
  completed: number;
  failed: number;
  skipped: number;
  [key: string]: unknown;
}

export const reviewApi = {
  health: ({ staleDays = 90, limit = 100 }: ReviewHealthOptions = {}, options: RequestOptions = {}): Promise<ReviewHealthReport> => http.get<ReviewHealthReport>('/review/health', {
    query: { staleDays, limit },
    ...options,
  }),
  createPlan: (findingIds: string[], options: ReviewRequestOptions = {}): Promise<ReviewPlan> => http.post<ReviewPlan>('/review/health/plan', {
    findingIds,
    staleDays: options.staleDays ?? 90,
    limit: options.limit ?? 100,
  }, options),
  executePlan: (planId: string, planHash: string, confirmation: Record<string, unknown>, options: RequestOptions = {}): Promise<ReviewExecuteResult> => http.post<ReviewExecuteResult>('/review/health/execute', {
    planId,
    planHash,
    ...confirmation,
  }, options),
};
