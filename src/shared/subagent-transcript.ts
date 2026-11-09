/** 子代理详情转录里 thinking 块的占位文案。
 *  主进程净化投影（official-subagent）与渲染层（subagents/ChatView）共用同一常量：
 *  详情面板默认折叠、显示与历史行为一致；点开时才按 entryId+blockIndex 单独 IPC
 *  拉取真实思考内容（见 subagentChildThinking）。 */
export const OMITTED_THINKING_TEXT = '[子代理详情省略思考内容]';
