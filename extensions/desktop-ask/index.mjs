/**
 * Desktop ask_user_question tool: ZCode-style blocking questions.
 *
 * pi's RPC UI only offers plain-string select/confirm/input, which cannot
 * carry option descriptions or multi-select. This tool encodes the question
 * payload into a reserved ui.input request; the Desktop renderer recognizes
 * the reserved title and renders rich question cards, replying with a JSON
 * answer through the normal extension_ui_response channel (so stop/cancel
 * semantics keep working). A plain TUI shows an input box where the user can
 * answer with option numbers, e.g. "1" or "1,3".
 */

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;

function normalizeQuestions(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_QUESTIONS) {
    throw new Error(`questions 需要 1-${MAX_QUESTIONS} 个问题`);
  }
  return input.map((q, qi) => {
    if (!q || typeof q.question !== 'string' || !q.question.trim()) throw new Error(`第 ${qi + 1} 个问题缺少 question`);
    const options = Array.isArray(q.options) ? q.options.filter(o => o && typeof o.label === 'string' && o.label.trim()) : [];
    if (options.length < 2 || options.length > MAX_OPTIONS) throw new Error(`第 ${qi + 1} 个问题需要 2-${MAX_OPTIONS} 个选项（含 label）`);
    return {
      header: String(q.header ?? '').trim().slice(0, 12) || `问题 ${qi + 1}`,
      question: q.question.trim(),
      multiSelect: !!q.multiSelect,
      options: options.slice(0, MAX_OPTIONS).map(o => ({
        label: String(o.label).trim().slice(0, 80),
        description: typeof o.description === 'string' ? o.description.slice(0, 300) : '',
      })),
    };
  });
}

/** CLI fallback: "1", "1,3"、"1、3" → option labels of the (single) question. */
function parseNumericReply(reply, questions) {
  const parts = reply.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
  if (!parts.length || !parts.every(p => /^\d+$/.test(p))) return null;
  const q = questions[0];
  const picked = parts.map(p => q.options[Number(p) - 1]).filter(Boolean);
  if (!picked.length) return null;
  return [{ header: q.header, answers: picked.map(o => o.label) }];
}

export default function desktopAsk(pi) {
  pi.registerTool({
    name: 'ask_user_question',
    label: '询问用户',
    description: [
      'Ask the user clarifying questions with selectable options before acting on ambiguous requirements.',
      'In Desktop this renders as rich question cards (header, question, options with descriptions, optional multi-select).',
      'Rules: 1-4 questions; each has a short header (<=12 chars), 2-4 options with label+description; set multiSelect only when several options may apply.',
      'Returns the user-selected labels per question, or a cancellation notice.',
    ].join(' '),
    parameters: {
      type: 'object', required: ['questions'], additionalProperties: false,
      properties: {
        questions: {
          type: 'array', minItems: 1, maxItems: MAX_QUESTIONS,
          items: {
            type: 'object', required: ['question', 'options'], additionalProperties: false,
            properties: {
              header: { type: 'string', maxLength: 12, description: '短标签，如 实现方案' },
              question: { type: 'string', minLength: 1, description: '要问的问题' },
              multiSelect: { type: 'boolean', description: '是否允许多选' },
              options: {
                type: 'array', minItems: 2, maxItems: MAX_OPTIONS,
                items: {
                  type: 'object', required: ['label'], additionalProperties: false,
                  properties: {
                    label: { type: 'string', minLength: 1, maxLength: 80 },
                    description: { type: 'string', maxLength: 300 },
                  },
                },
              },
            },
          },
        },
      },
    },
    async execute(_id, args, signal, _onUpdate, ctx) {
      // pi 工具签名是 5 参：execute(toolCallId, params, signal, onUpdate, ctx)。
      // 之前把 ctx 放在第 3 位拿到的是 AbortSignal，导致 ctx.ui undefined。
      const questions = normalizeQuestions(args?.questions);
      if (signal?.aborted) {
        return { content: [{ type: 'text', text: '用户取消了提问。请按最佳判断继续，或稍后用更简单的问法再问。' }], details: { cancelled: true } };
      }
      const payload = JSON.stringify({ v: 1, questions });
      const reply = await ctx.ui.input('desktop-ask', payload, { signal });
      if (ctx?.signal?.aborted || reply === undefined) {
        return { content: [{ type: 'text', text: '用户取消了提问。请按最佳判断继续，或稍后用更简单的问法再问。' }], details: { cancelled: true } };
      }
      let answers;
      try {
        const parsed = JSON.parse(reply);
        answers = Array.isArray(parsed) ? parsed : parseNumericReply(reply, questions);
      } catch {
        answers = parseNumericReply(reply, questions);
      }
      answers ??= [];
      if (!answers.length) {
        return { content: [{ type: 'text', text: '用户没有给出有效选择。请按最佳判断继续。' }], details: { answers: [] } };
      }
      const text = answers.map(a => `${a.header}: ${a.answers.join('、')}`).join('\n');
      return { content: [{ type: 'text', text }], details: { answers } };
    },
  });
}
