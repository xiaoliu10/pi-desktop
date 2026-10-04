// PI Desktop codemode nudge extension
// Non-GPT models adopt the codemode tool at a much lower rate: pi ships only a
// single abstract guideline ("batch independent tool calls") with no decisive
// trigger line or scenario mapping, and AGENTS.md "尽量" wording is too weak to
// change tool-selection habits. This extension ships with Desktop sessions and
// adds two layers of guidance:
// 1) System prompt: replace the codemode tool guideline with a decidable rule
//    (2+ planned tool calls → one codemode script) plus concrete scenarios.
// 2) In-flight reminder: on the 3rd consecutive direct base-tool call within one
//    agent loop (calls issued from inside a codemode script don't count), append
//    a gentle reminder to the tool result; at most 2 reminders per loop.
// Kill switch: set PI_DESKTOP_NO_CODEMODE_NUDGE=1 to disable everything.
export default function(pi) {
  if (process.env.PI_DESKTOP_NO_CODEMODE_NUDGE === '1') return;
  // 替换 pi 内置的单条抽象 guideline。新文本覆盖其原语义（batch/chain/filter）
  // 并补上可判定触发线与场景；pi 升级若改写内置 guideline 需要同步评估本替换。
  // 注意：pi 的 buildRules 会给每条 guideline 加 "- " 前缀，条目自身不要再带。
  const GUIDELINES = [
    "Efficiency rule: prefer codemode for multi-step tool work. If you are about to make 2 or more tool calls in one turn (read/grep/find/ls/bash/edit/write in any combination), run them as ONE codemode script instead: batch independent calls with Promise.allSettled, chain outputs, or loop.",
    "Typical codemode wins: exploring a codebase (find → grep → read in one script), multi-file changes (read → edit → verify per file), running a command and processing its output.",
    "A single trivial call may use the tool directly. Never chain 3+ separate tool calls in one turn when one codemode script covers them.",
  ];
  // codemode 不在本次会话的可用工具里时，运行中提醒只会指向模型没有的工具。
  let codemodeAvailable = false;
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.toolGuidelines.codemode = [...GUIDELINES];
    codemodeAvailable = event.systemPromptOptions.selectedTools.includes("codemode");
  });

  // In-flight 提醒：直接调用的基础工具连续 3 次（同一 agent loop）时提醒一次。
  const BASE_TOOLS = new Set(["read", "bash", "powershell", "grep", "find", "ls", "edit", "write"]);
  const REMIND_AFTER = 3, MAX_PER_LOOP = 2;
  let streak = 0, reminders = 0;
  pi.on("agent_start", () => { streak = 0; reminders = 0; });
  pi.on("tool_result", (event) => {
    if (event.parentToolCallId || event.toolName === "codemode") { streak = 0; return undefined; } // 采用/脚本内部调用：清零
    if (!codemodeAvailable || !BASE_TOOLS.has(event.toolName)) return undefined;
    streak += 1;
    if (streak < REMIND_AFTER || reminders >= MAX_PER_LOOP) return undefined;
    reminders += 1; streak = 0;
    return {
      content: [...event.content, { type: "text", text: `(codemode nudge) That's ${REMIND_AFTER} separate tool calls in this turn. Batch the remaining steps into ONE codemode script (tools.read/tools.bash/... with Promise.allSettled or sequential awaits) — fewer round trips, and large outputs can be filtered before they reach you.` }],
      // 契约：返回 content 即整体替换结果；不透传 structuredContent 会让运行时
      // 把原机器可读输出删掉（bash 的 structuredContent.output 供程序化调用方消费）。
      structuredContent: event.structuredContent,
    };
  });
}
