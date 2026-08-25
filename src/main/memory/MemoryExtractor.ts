import type { MemoryEntryKind, MemoryScope } from "../agents/orchestrationTypes";
import type { MemoryDecision, MemoryObserverInput } from "./memoryTypes";
import { memorySummaryForContent, memoryTypeForKind } from "./MemoryRanker";

const MAX_EXTRACTED_LENGTH = 180;
const CANONICAL_PREFIXES = [
  "用户偏好：",
  "长期规则：",
  "项目规则：",
  "项目事实：",
  "项目决策：",
  "Agent规则：",
  "稳定工作流：",
  "长期事实：",
] as const;

const EXPLICIT_FORGET_SIGNAL = /(?:忘记|忘掉|不要记(?:住)?|以后不要记(?:住)?)|(?:删除|移除).*(?:记忆|这条|刚才|上一条|这个)/i;
const EXPLICIT_REMEMBER_SIGNAL = /^(?:请|帮我|麻烦你)?\s*(?:记住|记一下|记得)(?:我说的|这件事)?(?:[：:,，\s]*).+/i;
const QUESTION_SIGNAL = /^(?:什么|为何|为什么|怎么|如何|能否|是否|可不可以|请问|我想知道|想问|请教)|(?:是什么|为什么|怎么|如何|能否|是否)|[?？]|(?:吗|呢|么)[。！!。！？?？]*$/i;
const ACKNOWLEDGEMENT_SIGNAL = /^(?:好的?|谢谢|感谢|收到|明白|继续|可以|行|嗯|啊|你好|在吗)[。！!？?，,]*$/i;
const TASK_PREFIX_SIGNAL = /^(?:请问|能不能|可以帮我|帮我|麻烦(?:你)?|请(?:把|给我|帮我)|把我|修复|修改|实现|添加|删除|检查|运行|执行|打开|查看|扫描|提交|发布|部署|构建|测试|解释|介绍|总结|写一个|给我)/i;
const TEMPORARY_SIGNAL = /(?:刚刚|现在正在|正在处理|报错|失败|错误|异常|卡住|崩溃|连接不上|连接中断|中断|临时(?:问题|故障|bug|错误)|今天这次|这次)/i;
const TASK_ACTION_SIGNAL = /(?:修复|修改|实现|添加|删除|检查|运行|执行|打开|查看|扫描|提交|发布|部署|构建|测试|解释|介绍|总结|截图|发送|查询|排查)/i;
const RULE_SIGNAL = /(?:以后|今后|从现在开始|默认|必须|禁止|请勿|不要|总是|始终|只能|不得|固定|约定|规范)/i;
const PREFERENCE_SIGNAL = /(?:喜欢|偏好|习惯|希望|需要|不喜欢|不希望|称呼|风格|格式|语言|简洁|详细|中文|英文)/i;
const USER_FACT_SIGNAL = /^(?:我叫|我是|我的(?:名字|职业|时区|语言|地区)|我在|I am\b|my name is\b|my timezone is\b)/i;
const PROJECT_SIGNAL = /(?:项目|仓库|代码库|团队|工程|技术栈|代码规范|项目中|仓库中)/i;
const DECISION_SIGNAL = /(?:决定|改成|切换到|采用|不采用|确定|选用)/i;
const REUSABLE_WORKFLOW_SIGNAL = /(?:每次|每当|固定流程|工作流|发布流程|开发流程|统一先|统一再)/i;
const MULTI_SEMANTIC_SIGNAL = /(?:，|,)(?:并且|而且|同时|另外|此外|以及)|(?:并且|而且|同时|另外|此外)\s*(?:我|项目|我们|默认|必须|以后)/i;

function normalizeText(value: string, maxLength = 6000): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function stripPunctuation(value: string): string {
  return value.replace(/^[\s，,：:；;。.!！?？]+|[\s，,：:；;。.!！?？]+$/g, "").trim();
}

function stripMemoryPrefix(value: string): string {
  return value
    .replace(/^(?:用户偏好|长期规则|项目规则|项目事实|项目决策|Agent规则|稳定工作流|长期事实)\s*[:：]\s*/i, "")
    .replace(/^(?:并且|而且|同时|另外|此外|以及)\s*/i, "")
    .trim();
}

export function isExplicitRememberRequest(value: string): boolean {
  return EXPLICIT_REMEMBER_SIGNAL.test(normalizeText(value));
}

export function isExplicitForgetRequest(value: string): boolean {
  return EXPLICIT_FORGET_SIGNAL.test(normalizeText(value));
}

/**
 * Storage accepts only this deliberately small, self-describing format. A
 * prefix is the last-line defense against a caller accidentally persisting a
 * transcript clause or a task request without going through extraction.
 */
export function isCanonicalMemoryContent(value: string): boolean {
  const normalized = normalizeText(value, MAX_EXTRACTED_LENGTH + 20);
  return normalized.length >= 8
    && normalized.length <= MAX_EXTRACTED_LENGTH
    && CANONICAL_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    && !QUESTION_SIGNAL.test(normalized)
    && !TASK_PREFIX_SIGNAL.test(normalized.slice(normalized.indexOf("：") + 1))
    && !TEMPORARY_SIGNAL.test(normalized)
    && !MULTI_SEMANTIC_SIGNAL.test(normalized);
}

export function needsMemoryReorganization(value: string): boolean {
  return !isCanonicalMemoryContent(value);
}

function splitIntoClauses(value: string): string[] {
  return value
    .replace(/(?:^|\s)(?:[-*•]|\d+[.)、])\s*/g, "\n")
    .split(/[。！？!?；;\n]+|(?<=[，,])(?=(?:并且|而且|同时|另外|此外|以及|以后|今后|默认|必须|禁止|请勿|不要|我喜欢|我偏好|我习惯|我希望|项目|我们))/u)
    .map((clause) => stripPunctuation(clause))
    .filter(Boolean);
}

function isQuestionOrTransient(clause: string, fullMessage: string, explicit: boolean): boolean {
  if (clause.length < 4 || clause.length > 320) return true;
  if (ACKNOWLEDGEMENT_SIGNAL.test(clause)) return true;
  if (QUESTION_SIGNAL.test(clause) || QUESTION_SIGNAL.test(fullMessage)) return true;
  if (TEMPORARY_SIGNAL.test(clause) && !RULE_SIGNAL.test(clause) && !PREFERENCE_SIGNAL.test(clause)) return true;

  const taskLike = TASK_PREFIX_SIGNAL.test(clause)
    || (PREFERENCE_SIGNAL.test(clause) && TASK_ACTION_SIGNAL.test(clause) && /(?:我需要|我希望|请你|帮我)/i.test(clause));
  if (taskLike && !(explicit && !TASK_ACTION_SIGNAL.test(clause)) && !RULE_SIGNAL.test(clause) && !REUSABLE_WORKFLOW_SIGNAL.test(clause)) return true;

  // A process instruction is not a reusable workflow unless recurrence is
  // explicit. This prevents "先运行 X 再提交 Y" from becoming a memory.
  if (TASK_ACTION_SIGNAL.test(clause) && !RULE_SIGNAL.test(clause) && !REUSABLE_WORKFLOW_SIGNAL.test(clause)) return true;
  return false;
}

function isDurableCandidate(clause: string, fullMessage: string, explicit: boolean): boolean {
  if (isQuestionOrTransient(clause, fullMessage, explicit)) return false;
  if (PREFERENCE_SIGNAL.test(clause) || USER_FACT_SIGNAL.test(clause) || RULE_SIGNAL.test(clause) || PROJECT_SIGNAL.test(clause) || DECISION_SIGNAL.test(clause)) return true;
  return REUSABLE_WORKFLOW_SIGNAL.test(clause);
}

function scopePart(value: string | undefined, maxLength: number): string | undefined {
  const normalized = normalizeText(value ?? "", maxLength).replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
  return normalized || undefined;
}

function kindFor(clause: string, input: MemoryObserverInput): MemoryEntryKind {
  if (DECISION_SIGNAL.test(clause)) return "decision";
  if (REUSABLE_WORKFLOW_SIGNAL.test(clause) && TASK_ACTION_SIGNAL.test(clause)) return "workflow";
  if (PROJECT_SIGNAL.test(clause) && !PREFERENCE_SIGNAL.test(clause)) return RULE_SIGNAL.test(clause) ? "rule" : "project_fact";
  if (input.activeAgent && RULE_SIGNAL.test(clause) && !PREFERENCE_SIGNAL.test(clause)) return "agent_rule";
  if (RULE_SIGNAL.test(clause)) return "rule";
  if (PREFERENCE_SIGNAL.test(clause)) return "preference";
  if (USER_FACT_SIGNAL.test(clause)) return "fact";
  return input.currentProject ? "project_fact" : "fact";
}

function scopeFor(input: MemoryObserverInput, kind: MemoryEntryKind): MemoryScope {
  const project = scopePart(input.currentProject, 80);
  const agent = scopePart(input.activeAgent?.id || input.agentProvider, 48);
  if (project && (kind === "project_fact" || kind === "rule" || kind === "decision" || kind === "workflow" || kind === "agent_rule")) {
    return agent && kind === "agent_rule" ? `project:${project}:agent:${agent}` : `project:${project}`;
  }
  if (agent && kind === "agent_rule") return `agent:${agent}`;
  return "user";
}

function prefixFor(kind: MemoryEntryKind): string {
  switch (kind) {
    case "preference": return "用户偏好：";
    case "rule": return "项目规则：";
    case "project_fact": return "项目事实：";
    case "decision": return "项目决策：";
    case "agent_rule": return "Agent规则：";
    case "workflow": return "稳定工作流：";
    default: return "长期事实：";
  }
}

function distillClause(clause: string, input: MemoryObserverInput): { content: string; kind: MemoryEntryKind; scope: MemoryScope } | null {
  let body = stripMemoryPrefix(clause)
    .replace(/^(?:请|麻烦你|请你)\s*/i, "")
    .replace(/^(?:以后|今后|从现在开始|从今天开始)\s*[，,：:]?\s*/i, "")
    .replace(/^(?:对于|关于)?\s*(?:这个|本|该)?(?:项目|仓库|代码库)\s*(?:中|里|内)?\s*/i, "项目")
    .replace(/^我们\s*(?:约定|决定|统一)?\s*/i, "项目")
    .replace(/^我(?:个人)?\s*/i, "")
    .replace(/^(?:并且|而且|同时|另外|此外|以及)\s*/i, "")
    .replace(/\s+/g, " ");
  body = stripPunctuation(body);
  const kind = kindFor(clause, input);
  if (kind === "rule" || kind === "project_fact" || kind === "decision") {
    body = body.replace(/^项目(?=(?:使用|采用|禁止|必须|默认|决定|改成|切换到|不采用|统一|约定))/i, "");
  }
  if (kind === "fact" && !/^用户/.test(body)) body = `用户${body}`;
  if (!body || body.length > MAX_EXTRACTED_LENGTH - 10) return null;
  const content = `${prefixFor(kind)}${body}。`;
  if (!isCanonicalMemoryContent(content)) return null;
  return { content, kind, scope: scopeFor(input, kind) };
}

function importanceFor(kind: MemoryEntryKind): number {
  if (kind === "agent_rule" || kind === "rule") return 0.95;
  if (kind === "decision" || kind === "workflow") return 0.9;
  if (kind === "project_fact") return 0.86;
  return 0.82;
}

function forgetTarget(value: string): string | undefined {
  const target = value
    .replace(/^(?:请|麻烦|帮我)?\s*(?:忘记|忘掉|删除)(?:这条|刚才那条|上一条|这个记忆)?\s*/i, "")
    .replace(/^(?:请|麻烦|帮我)?\s*(?:不要记(?:住)?|以后不要记(?:住)?)\s*/i, "")
    .replace(/[：:，,。.!！?？]+$/g, "")
    .trim();
  return target || undefined;
}

/** Extracts reusable memory candidates without asking an Agent or saving text. */
export function extractMemoryDecisions(input: MemoryObserverInput): MemoryDecision[] {
  const fullMessage = normalizeText(input.userMessage);
  if (!fullMessage) return [];
  if (isExplicitForgetRequest(fullMessage)) {
    return [{
      action: "DELETE",
      target: forgetTarget(fullMessage),
      scope: "user",
      importance: 1,
      confidence: 1,
      workspaceId: input.workspaceId,
      reason: "explicit-forget",
    }];
  }

  const explicit = isExplicitRememberRequest(fullMessage);
  const stripped = explicit
    ? fullMessage.replace(/^(?:请|帮我|麻烦你)?\s*(?:记住|记一下|记得)(?:我说的|这件事)?[：:,，\s]*/i, "")
    : fullMessage;
  const decisions: MemoryDecision[] = [];
  const seen = new Set<string>();
  for (const clause of splitIntoClauses(stripped)) {
    if (!isDurableCandidate(clause, fullMessage, explicit)) continue;
    const distilled = distillClause(clause, input);
    if (!distilled || seen.has(distilled.content)) continue;
    seen.add(distilled.content);
    decisions.push({
      action: "ADD",
      kind: distilled.kind,
      type: memoryTypeForKind(distilled.kind, distilled.scope),
      scope: distilled.scope,
      content: distilled.content,
      summary: memorySummaryForContent(distilled.content),
      importance: importanceFor(distilled.kind),
      confidence: explicit ? 1 : 0.9,
      createdAt: new Date().toISOString(),
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      reason: explicit ? "explicit-distilled" : "durable-distilled",
    });
  }
  return decisions;
}

export default extractMemoryDecisions;
