import { config } from "dotenv";
import OpenAI from "openai";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// 加载项目根目录下的 .env
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

// 直接读取环境变量（BASE_URL / API_KEY / MODEL_ID 均在 .env 中配置）
const BASE_URL = process.env.BASE_URL ?? "https://aihubmix.com/v1";
const API_KEY = process.env.API_KEY ?? "";
const MODEL = process.env.MODEL_ID ?? "deepseek-chat";

// banner 显示用：取接口域名
const provider = new URL(BASE_URL).host;

if (!API_KEY) {
  console.error("缺少 API_KEY，请在 .env 中配置。");
  process.exit(1);
}

// DeepSeek（或任意 OpenAI 兼容模型）通过网关以 OpenAI 兼容接口暴露
export const client = new OpenAI({
  baseURL: BASE_URL,
  apiKey: API_KEY,
});

export { MODEL, provider, BASE_URL };

export const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

// ── 工具定义：仅 bash ────────────────────────────
export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
        },
        required: ["command"],
      },
    },
  },
];
