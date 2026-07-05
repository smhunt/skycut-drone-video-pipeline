/** Optional callback long-running pipelines use to surface progress (MCP notifications, logs, tests). */
export type ProgressReporter = (progress: number, total: number, message: string) => void;
