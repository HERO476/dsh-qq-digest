/**
 * 摘要器工厂：按配置选 heuristic 或 llm。
 *
 * 注意 llm 分支是「构造时就要求密钥」还是「调用时才要求」：
 * 这里选**调用时**，因为 MCP 进程可能先起来、密钥后配；
 * 构造期就抛错会让整个插件起不来，反而更难排查。
 */

import { summarizeMessages } from './summarize.js';
import { createLlmSummarizer } from './summarize-llm.js';

/**
 * @param {{summarizer:'heuristic'|'llm'}} config
 * @param {{llm?:object, fetchImpl?:Function}} deps
 * @returns {(input:{messages:Array<object>, roomTitle?:string|null}) => Promise<object>|object}
 */
export function createSummarizerFromConfig(config, { llm, fetchImpl } = {}) {
  if (config?.summarizer === 'llm') {
    let cached = null;
    return async (input) => {
      if (!cached) cached = createLlmSummarizer({ ...(llm ?? {}), fetchImpl });
      return cached(input);
    };
  }
  return (input) => summarizeMessages(input);
}
