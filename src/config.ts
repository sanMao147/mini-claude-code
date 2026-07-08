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
const FALLBACK_MODEL = process.env.FALLBACK_MODEL_ID || undefined; // s11: 连续 529 时切换

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

export { MODEL, FALLBACK_MODEL, provider, BASE_URL };




// ── 工具定义：bash + 4 个 file 工具（s02 起）──
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
          run_in_background: {
            type: "boolean",
            description: "If true, run the command in the background and continue. Result arrives as a notification.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file, relative to workspace." },
          limit: { type: "integer", description: "Optional max number of lines to read." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file (creates parent dirs).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file, relative to workspace." },
          content: { type: "string", description: "Content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exact text in a file once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file, relative to workspace." },
          old_text: { type: "string", description: "Exact text to find." },
          new_text: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern relative to the workspace.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts'." } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description: "Create and manage a task list for your current coding session.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task",
      description: "Launch a subagent to handle a complex subtask. Returns only the final conclusion.",
      parameters: {
        type: "object",
        properties: { description: { type: "string", description: "The self-contained task for the subagent." } },
        required: ["description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description: "Load the full content of a skill by name (catalog is shown in the system prompt).",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name from the catalog." } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compact",
      description: "Summarize earlier conversation to free context space when it gets long.",
      parameters: {
        type: "object",
        properties: { focus: { type: "string", description: "Optional focus hint for the summary." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Create a new persisted task with optional blockedBy dependencies.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Short title of the task." },
          description: { type: "string", description: "Free-form description." },
          blockedBy: { type: "array", items: { type: "string" }, description: "Task IDs this task depends on." },
        },
        required: ["subject"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "List all tasks with status, owner, and dependencies.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_task",
      description: "Get full details of a specific task by ID.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string", description: "The task ID." } },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "claim_task",
      description: "Claim a pending task. Sets owner and status to in_progress. Blocked until dependencies complete.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string", description: "The task ID." } },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "Complete an in-progress task. Reports unblocked downstream tasks.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string", description: "The task ID." } },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_cron",
      description: "Schedule a recurring or one-shot cron job. cron is 5-field: min hour dom month dow.",
      parameters: {
        type: "object",
        properties: {
          cron: { type: "string", description: "5-field cron expression, e.g. '0 9 * * *'." },
          prompt: { type: "string", description: "Message injected when the job fires." },
          recurring: { type: "boolean", description: "True=recurring, False=one-shot." },
          durable: { type: "boolean", description: "True=persist to disk across restarts." },
        },
        required: ["cron", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_crons",
      description: "List all registered cron jobs.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_cron",
      description: "Cancel a cron job by ID.",
      parameters: {
        type: "object",
        properties: { job_id: { type: "string", description: "The cron job ID." } },
        required: ["job_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_teammate",
      description: "Spawn a teammate agent in the background to handle a subtask.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique teammate name/id." },
          role: { type: "string", description: "Short role description." },
          prompt: { type: "string", description: "Self-contained task for the teammate." },
        },
        required: ["name", "role", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message",
      description: "Send a message to a teammate via the MessageBus.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient teammate name." },
          content: { type: "string", description: "Message content." },
        },
        required: ["to", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_inbox",
      description: "Check the Lead's inbox for teammate messages (destructive read).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_shutdown",
      description: "Request a teammate to shut down gracefully (protocol).",
      parameters: {
        type: "object",
        properties: { teammate: { type: "string", description: "Teammate name to shut down." } },
        required: ["teammate"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_plan",
      description: "Ask a teammate to submit a plan for a task (protocol).",
      parameters: {
        type: "object",
        properties: {
          teammate: { type: "string", description: "Teammate name." },
          task: { type: "string", description: "Task description to plan." },
        },
        required: ["teammate", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "review_plan",
      description: "Approve or reject a submitted plan by request_id (protocol).",
      parameters: {
        type: "object",
        properties: {
          request_id: { type: "string", description: "The plan request id." },
          approve: { type: "boolean", description: "True=approve, False=reject." },
          feedback: { type: "string", description: "Optional feedback when rejecting." },
        },
        required: ["request_id", "approve"],
      },
    },
  },
  // s18: worktree isolation
  {
    type: "function",
    function: {
      name: "create_worktree",
      description: "Create an isolated git worktree with its own branch (wt/<name>). Optionally bind to a task.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Worktree name (letters/digits/._- , 1-64 chars)." },
          task_id: { type: "string", description: "Optional task id to bind to this worktree." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_worktree",
      description: "Remove a worktree. Refuses if uncommitted/unpushed changes unless discard_changes=true.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Worktree name." },
          discard_changes: { type: "boolean", description: "Force removal ignoring pending changes." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "keep_worktree",
      description: "Keep a worktree for manual review (branch preserved).",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Worktree name." } },
        required: ["name"],
      },
    },
  },
];
