import type OpenAI from "openai";
import { client, MODEL } from "./config.js";

// ── s08: Context Compact — 四层压缩管线 ────────────
//   原则：便宜的先做，昂贵的最后做。
//     L3 tool_result_budget：大结果落盘
//     L1 snip_compact：超出条数裁剪中间消息
//     L2 micro_compact：旧 tool 结果替换为占位符
//     L4 compact_history：LLM 全文摘要（1 次 API 调用）
//   紧急：reactive_compact —— API 仍报过长时触发

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const CONTEXT_LIMIT = 50_000;
const KEEP_RECENT = 3;
const PERSIST_THRESHOLD = 30_000;

function estimateSize(msgs: Msg[]): number {
  return JSON.stringify(msgs).length;
}

function isToolMessage(m: Msg): m is OpenAI.Chat.Completions.ChatCompletionToolMessageParam {
  return m.role === "tool";
}
function hasToolCalls(m: Msg): boolean {
  return m.role === "assistant" && Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0;
}

// L1: 裁剪中间消息
export function snipCompact(messages: Msg[], maxMessages = 50): Msg[] {
  if (messages.length <= maxMessages) return messages;
  let headEnd = 3;
  let tailStart = messages.length - (maxMessages - 3);
  while (headEnd < messages.length && isToolMessage(messages[headEnd])) headEnd++;
  while (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolMessage(messages[tailStart]) &&
    hasToolCalls(messages[tailStart - 1])
  ) {
    tailStart--;
  }
  if (headEnd >= tailStart) return messages;
  const snipped = tailStart - headEnd;
  return [
    ...messages.slice(0, headEnd),
    { role: "user", content: `[snipped ${snipped} messages]` } as Msg,
    ...messages.slice(tailStart),
  ];
}

// L2: 旧 tool 结果替换为占位符（保留最近 KEEP_RECENT 条）
export function microCompact(messages: Msg[]): Msg[] {
  const toolMsgs = messages.filter(isToolMessage);
  if (toolMsgs.length <= KEEP_RECENT) return messages;
  const oldOnes = toolMsgs.slice(0, toolMsgs.length - KEEP_RECENT);
  const ids = new Set(oldOnes.map((m) => (m as any).tool_call_id));
  return messages.map((m) => {
    if (
      m.role === "tool" &&
      ids.has((m as any).tool_call_id) &&
      typeof m.content === "string" &&
      m.content.length > 120
    ) {
      return { ...m, content: "[Earlier tool result compacted. Re-run if needed.]" } as Msg;
    }
    return m;
  });
}

// L3: 超大 tool 结果落盘（返回预览）
export function toolResultBudget(messages: Msg[], maxBytes = 200_000): Msg[] {
  const toolMsgs = messages.filter(isToolMessage) as any[];
  let total = toolMsgs.reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : 0), 0);
  if (total <= maxBytes) return messages;
  const ranked = [...toolMsgs].sort(
    (a, b) => (b.content?.length ?? 0) - (a.content?.length ?? 0),
  );
  for (const m of ranked) {
    if (total <= maxBytes) break;
    const c = typeof m.content === "string" ? m.content : "";
    if (c.length <= PERSIST_THRESHOLD) continue;
    m.content = `<persisted-output>\nPreview:\n${c.slice(0, 2000)}\n</persisted-output>`;
    total = toolMsgs.reduce((s, mm) => s + (typeof mm.content === "string" ? mm.content.length : 0), 0);
  }
  return messages;
}

async function summarize(messages: Msg[]): Promise<string> {
  const conversation = JSON.stringify(messages).slice(0, 80_000);
  const prompt =
    "Summarize this coding-agent conversation so work can continue.\n" +
    "Preserve: 1. current goal, 2. key findings/decisions, 3. files read/changed, " +
    "4. remaining work, 5. user constraints.\nBe compact but concrete.\n\n" +
    conversation;
  const resp = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2000,
  });
  return resp.choices[0].message.content?.trim() || "(empty summary)";
}

// L4: 全文摘要
export async function compactHistory(messages: Msg[]): Promise<Msg[]> {
  const summary = await summarize(messages);
  return [{ role: "user", content: `[Compacted]\n\n${summary}` } as Msg];
}

// 紧急压缩：保留最近 5 条 + 摘要
export async function reactiveCompact(messages: Msg[]): Promise<Msg[]> {
  const tailStart = Math.max(0, messages.length - 5);
  const summary = await summarize(messages.slice(0, tailStart));
  return [
    { role: "user", content: `[Reactive compact]\n\n${summary}` } as Msg,
    ...messages.slice(tailStart),
  ];
}

// 便宜的三层预处理（0 次 API 调用）
export function preCompact(messages: Msg[]): Msg[] {
  let m = toolResultBudget(messages);
  m = snipCompact(m);
  m = microCompact(m);
  return m;
}

export function needsCompact(messages: Msg[]): boolean {
  return estimateSize(messages) > CONTEXT_LIMIT;
}

export const COMPACT_TOOL_RESULT = "[Compacted. Conversation history has been summarized.]";
