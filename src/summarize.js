/**
 * 本地启发式摘要器：零网络、零成本、可解释。
 *
 * 它只做「把一群消息里像任务/决定/问题的句子挑出来并归类」，
 * 不做语义改写，因此质量有上限——这是刻意的取舍：
 * 没有模型密钥时也要能用，而不是直接报错。
 *
 * 输入永远是过了闸门的群消息，函数内不存在任何按会话类型分支的代码。
 */

const MAX_ITEMS = 8;

const TASK_HINT =
  /(待办|todo|to do|需要|麻烦|请帮|帮个忙|记得|别忘了|负责|跟进|排期|提交|发一下|整理|确认一下|核对|补充|更新|截止|ddl|deadline|今晚|今天|明天|后天|下周|周[一二三四五六日])/i;

const DECISION_HINT = /(决定|定了|就按|确定|敲定|结论|通过了?|拍板|统一|最终定)/i;

const QUESTION_HINT = /(\?|？|吗|呢|是不是|是否|怎么|如何|要不要|能不能)/i;

const DATE_HINT =
  /(今天|明天|后天|大后天|本周[一二三四五六日天]?|下周[一二三四五六日天]?|周[一二三四五六日天]|(\d{1,2})月(\d{1,2})[日号]|(\d{1,2})[点时](\d{1,2})?分?|月底|月初|下班前|上午|下午|晚上)/;

/**
 * @param {{messages: Array<{seq:number,time:number,isSelf:boolean,nickname:string,text:string}>}} input
 * @returns {object} 结构化摘要
 */
export function summarizeMessages({ messages = [] } = {}) {
  const rows = Array.isArray(messages) ? messages.filter((m) => typeof m?.text === 'string' && m.text.trim() !== '') : [];

  const participants = new Map();
  for (const row of rows) {
    const name = String(row.nickname ?? '').trim();
    if (name === '') continue;
    participants.set(name, (participants.get(name) ?? 0) + 1);
  }

  const tasks = [];
  const decisions = [];
  const questions = [];
  const highlights = [];

  for (const row of rows) {
    const text = clip(row.text, 160);
    const who = row.isSelf ? '我' : String(row.nickname ?? '某成员').trim() || '某成员';

    if (DECISION_HINT.test(text)) {
      decisions.push({ text, by: who });
      continue;
    }

    if (TASK_HINT.test(text)) {
      const due = DATE_HINT.exec(text);
      const owner = guessOwner(text) ?? who;
      tasks.push({ what: text, owner, due: due ? due[0] : null });
      continue;
    }

    if (QUESTION_HINT.test(text)) {
      questions.push({ text, by: who });
      continue;
    }
  }

  // 亮点：按「信息量」排序（长度 + 带日期的加分），取前若干条，跳过已经在任务里的。
  const taskTexts = new Set(tasks.map((t) => t.what));
  const scored = rows
    .map((row) => ({
      text: clip(row.text, 120),
      who: row.isSelf ? '我' : String(row.nickname ?? '某成员').trim() || '某成员',
      score: clip(row.text, 400).length + (DATE_HINT.test(row.text) ? 30 : 0),
    }))
    .filter((item) => !taskTexts.has(item.text))
    .sort((a, b) => b.score - a.score);

  for (const item of scored) {
    if (highlights.length >= MAX_ITEMS) break;
    highlights.push(`${item.who}：${item.text}`);
  }

  const times = rows.map((row) => Number(row.time)).filter((t) => Number.isFinite(t) && t > 0);
  const stats = {
    messageCount: rows.length,
    participantCount: participants.size,
    timeFrom: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
    timeTo: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
  };

  return {
    summarizer: 'heuristic',
    overview: buildOverview(tasks, decisions, questions, stats),
    highlights: highlights.slice(0, MAX_ITEMS),
    tasks: tasks.slice(0, MAX_ITEMS),
    decisions: decisions.slice(0, MAX_ITEMS),
    questions: questions.slice(0, MAX_ITEMS),
    participants: [...participants.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, messages: count })),
    stats,
  };
}

function buildOverview(tasks, decisions, questions, stats) {
  const parts = [];
  parts.push(`本轮共 ${stats.messageCount} 条消息`);
  if (stats.participantCount > 0) parts.push(`${stats.participantCount} 位成员参与`);
  if (tasks.length > 0) parts.push(`识别到 ${tasks.length} 项待办`);
  if (decisions.length > 0) parts.push(`${decisions.length} 条结论`);
  if (questions.length > 0) parts.push(`${questions.length} 个待回答问题`);
  if (tasks.length === 0 && decisions.length === 0 && questions.length === 0) {
    parts.push('没有命中规则句，建议改用模型摘要或人工回看原文');
  }
  return `${parts.join('，')}。`;
}

/**
 * 猜负责人。宁可不猜，也不要猜错：
 * 只看「XX来」「XX负责」这种明确的指派句式，且排除「请把/让/帮我」这类动词串。
 * 猜不到就返回 null，由调用方回退成「发这条消息的人」。
 */
function guessOwner(text) {
  const match = /([\u4e00-\u9fa5A-Za-z0-9_-]{2,8})(?:来(?:做|排|写|跟|处理|负责)?|负责)/.exec(text);
  if (!match) return null;
  const candidate = match[1];
  if (/^(请|把|让|帮|帮我|麻烦|需要|先|再|已经|就|都)/.test(candidate)) return null;
  if (/(问题|一下|这个|那个|事情|东西|时间|方案)$/.test(candidate)) return null;
  return candidate;
}

function clip(text, max) {
  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}…`;
}
