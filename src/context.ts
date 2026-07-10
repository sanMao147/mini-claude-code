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

// 用 JSON 字符串长度粗略估算上下文大小。
// 这里不是精确 token 计算，只作为是否触发压缩的便宜启发式判断。
function estimateSize(msgs: Msg[]): number {
  return JSON.stringify(msgs).length;
}

// tool 消息是工具执行结果，通常最容易变大，也是压缩的主要目标。
function isToolMessage(m: Msg): m is OpenAI.Chat.Completions.ChatCompletionToolMessageParam {
  return m.role === "tool";
}

// assistant 如果带 tool_calls，后面必须紧跟对应 tool 结果；
// 裁剪历史时要避免把这一组调用链剪断。
function hasToolCalls(m: Msg): boolean {
  return m.role === "assistant" && Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0;
}

// L1: 裁剪中间消息
export function snipCompact(messages: Msg[], maxMessages = 50): Msg[] {
  if (messages.length <= maxMessages) return messages;

  // 保留最开始几条消息，通常包含用户初始目标和重要约束。
  let headEnd = 3;

  // 保留最近的消息，保证模型能继续当前正在进行的任务。
  let tailStart = messages.length - (maxMessages - 3);

  // 头部边界不要停在 tool 消息上，避免留下没有 assistant tool_call 的孤儿 tool 结果。
  while (headEnd < messages.length && isToolMessage(messages[headEnd])) headEnd++;

  // 尾部边界如果刚好落在 assistant/tool 调用链中间，就向前扩展，保留完整工具调用对。
  while (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolMessage(messages[tailStart]) &&
    hasToolCalls(messages[tailStart - 1])
  ) {
    tailStart--;
  }
  if (headEnd >= tailStart) return messages;

  // 中间被裁掉的部分用占位消息说明，避免模型误以为这里没有历史。
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

  // 只压缩较早的工具结果，最近几条原样保留，方便模型继续当前步骤。
  const oldOnes = toolMsgs.slice(0, toolMsgs.length - KEEP_RECENT);
  const ids = new Set(oldOnes.map((m) => (m as any).tool_call_id));
  return messages.map((m) => {
    if (
      m.role === "tool" &&
      ids.has((m as any).tool_call_id) &&
      typeof m.content === "string" &&
      m.content.length > 120
    ) {
      // 保留 tool_call_id 和 role，只替换 content，满足 OpenAI 工具消息配对要求。
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

  // 优先处理最大的工具输出，这样用最少替换次数把总量降下来。
  const ranked = [...toolMsgs].sort(
    (a, b) => (b.content?.length ?? 0) - (a.content?.length ?? 0),
  );
  for (const m of ranked) {
    if (total <= maxBytes) break;
    const c = typeof m.content === "string" ? m.content : "";
    if (c.length <= PERSIST_THRESHOLD) continue;

    // 当前实现只保留预览文本，没有真的写入文件；标签表达的是“完整输出已不在上下文里”。
    m.content = `<persisted-output>\nPreview:\n${c.slice(0, 2000)}\n</persisted-output>`;
    total = toolMsgs.reduce((s, mm) => s + (typeof mm.content === "string" ? mm.content.length : 0), 0);
  }
  return messages;
}

async function summarize(messages: Msg[]): Promise<string> {
  // 摘要模型只看前 80k 字符，避免“为了压缩而再次超上下文”。
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

  // 压缩后用一条 user 消息承载摘要，让后续模型把它当作继续工作的上下文。
  return [{ role: "user", content: `[Compacted]\n\n${summary}` } as Msg];
}

// 紧急压缩：保留最近 5 条 + 摘要
export async function reactiveCompact(messages: Msg[]): Promise<Msg[]> {
  // API 已经报上下文过长时，保守保留尾部最近交互，其余部分改成摘要。
  const tailStart = Math.max(0, messages.length - 5);
  const summary = await summarize(messages.slice(0, tailStart));
  return [
    { role: "user", content: `[Reactive compact]\n\n${summary}` } as Msg,
    ...messages.slice(tailStart),
  ];
}

// 便宜的三层预处理（0 次 API 调用）
export function preCompact(messages: Msg[]): Msg[] {
  // 顺序很重要：先压大工具输出，再按条数裁剪，最后替换旧工具结果。
  let m = toolResultBudget(messages);
  m = snipCompact(m);
  m = microCompact(m);
  return m;
}

export function needsCompact(messages: Msg[]): boolean {
  // 超过粗略大小阈值后，才进入需要 API 调用的 LLM 摘要压缩。
  return estimateSize(messages) > CONTEXT_LIMIT;
}

export const COMPACT_TOOL_RESULT = "[Compacted. Conversation history has been summarized.]";
