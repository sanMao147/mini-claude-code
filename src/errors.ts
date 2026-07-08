// ── s11: Error Recovery — 错误不是结束，是重试的起点 ──
//   三路径：max_tokens 升级/续写、prompt_too_long 响应式压缩、429/529 退避+换模型
//   复用 context.ts 的 LLM 摘要式 reactiveCompact（真实 CC 行为）。

export const DEFAULT_MAX_TOKENS = 8000;
export const ESCALATED_MAX_TOKENS = 64000;
export const MAX_RECOVERY_RETRIES = 3; // 续写最多 3 次
export const MAX_RETRIES = 10; // 瞬态错误最多 10 次
export const BASE_DELAY_MS = 500;
export const MAX_CONSECUTIVE_529 = 3; // 连续 3 次 529 切换备用模型
export const CONTINUATION_PROMPT =
  "Output token limit hit. Resume directly — " +
  "no apology, no recap. Pick up mid-thought.";

export interface RecoveryState {
  has_escalated: boolean;
  recovery_count: number;
  consecutive_529: number;
  has_attempted_reactive_compact: boolean;
  current_model: string;
}

export function newRecoveryState(primaryModel: string): RecoveryState {
  return {
    has_escalated: false,
    recovery_count: 0,
    consecutive_529: 0,
    has_attempted_reactive_compact: false,
    current_model: primaryModel,
  };
}

// 指数退避 + 抖动；Retry-After 优先
export function retryDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter != null) return retryAfter;
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 32000) / 1000;
  const jitter = Math.random() * (base * 0.25);
  return base + jitter;
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// 瞬态错误（429 限流 / 529 过载）指数退避；连续 529 切换备用模型；其余重抛
export async function withRetry<T>(
  fn: () => Promise<T>,
  state: RecoveryState,
  fallbackModel?: string,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      state.consecutive_529 = 0; // 成功则清空 529 计数
      return result;
    } catch (e: any) {
      const name = String(e?.constructor?.name ?? "Error").toLowerCase();
      const msg = String(e?.message ?? e).toLowerCase();

      // 429 限流
      if (name.includes("ratelimit") || msg.includes("429")) {
        const delay = retryDelay(attempt);
        console.log(
          `  \x1b[33m[429 rate limit] retry ${attempt + 1}/${MAX_RETRIES}, wait ${delay.toFixed(1)}s\x1b[0m`,
        );
        await sleep(delay);
        continue;
      }

      // 529 过载
      if (name.includes("overloaded") || msg.includes("529") || msg.includes("overloaded")) {
        state.consecutive_529 += 1;
        if (state.consecutive_529 >= MAX_CONSECUTIVE_529) {
          if (fallbackModel) {
            state.current_model = fallbackModel;
            state.consecutive_529 = 0;
            console.log(`  \x1b[31m[529 x${MAX_CONSECUTIVE_529}] switching to ${fallbackModel}\x1b[0m`);
          } else {
            state.consecutive_529 = 0;
            console.log(
              `  \x1b[31m[529 x${MAX_CONSECUTIVE_529}] no FALLBACK_MODEL_ID configured, continuing retry\x1b[0m`,
            );
          }
        }
        const delay = retryDelay(attempt);
        console.log(
          `  \x1b[33m[529 overloaded] retry ${attempt + 1}/${MAX_RETRIES}, wait ${delay.toFixed(1)}s\x1b[0m`,
        );
        await sleep(delay);
        continue;
      }

      // 非瞬态 → 上抛给外层处理
      throw e;
    }
  }
  throw new Error(`Max retries (${MAX_RETRIES}) exceeded`);
}

// API 报错是否表示上下文/prompt 过长
export function isPromptTooLongError(e: any): boolean {
  const msg = String(e?.message ?? e).toLowerCase();
  return (
    (msg.includes("prompt") && msg.includes("long")) ||
    msg.includes("prompt_is_too_long") ||
    msg.includes("context_length_exceeded") ||
    msg.includes("max_context_window") ||
    msg.includes("maximum context") ||
    msg.includes("too long") ||
    msg.includes("tokens")
  );
}
