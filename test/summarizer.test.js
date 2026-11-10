import test from 'node:test';
import assert from 'node:assert/strict';

import { createSummarizerFromConfig } from '../src/summarizer-factory.js';
import { parseJsonLoosely, normalizeDigest } from '../src/summarize-llm.js';

const MESSAGES = [{ seq: 1, time: 1762746000000, isSelf: false, nickname: '小林', text: '明天评审交互稿' }];

function fakeOpenAi(content) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

test('heuristic 分支返回同步函数（不是 Promise）', async () => {
  const summarize = createSummarizerFromConfig({ summarizer: 'heuristic' });
  const digest = summarize({ messages: MESSAGES });
  assert.equal(typeof digest.then, 'undefined', 'heuristic 不该返回 Promise');
  assert.equal(digest.summarizer, 'heuristic');
});

test('llm 分支返回可调用函数，而不是 Promise', async () => {
  const summarize = createSummarizerFromConfig(
    { summarizer: 'llm' },
    { llm: { baseUrl: 'http://x', model: 'm', apiKey: 'k' }, fetchImpl: fakeOpenAi('{"overview":"ok"}') },
  );
  assert.equal(typeof summarize, 'function');
  const digest = await summarize({ messages: MESSAGES });
  assert.equal(digest.summarizer, 'llm');
  assert.equal(digest.overview, 'ok');
});

test('缺密钥时调用报 LLM_KEY_MISSING，而不是「s is not a function」这类内部错误', async () => {
  const summarize = createSummarizerFromConfig({ summarizer: 'llm' }, { llm: { baseUrl: 'http://x', model: 'm', apiKey: null } });
  await assert.rejects(() => summarize({ messages: MESSAGES }), (err) => err.code === 'LLM_KEY_MISSING');
});

test('模型返回代码块包着的 JSON 也能解析', () => {
  assert.deepEqual(parseJsonLoosely('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoosely('好的，结果如下：{"a":2} 以上。'), { a: 2 });
  assert.throws(() => parseJsonLoosely('没有 JSON'), (err) => err.code === 'LLM_BAD_JSON');
});

test('normalizeDigest 把脏字段收拾干净', () => {
  const digest = normalizeDigest({
    overview: 'x'.repeat(1000),
    highlights: ['a', 123, '', 'b'],
    tasks: [{ what: '做事', owner: '我', due: null }, { what: '', owner: 'x' }, 'junk'],
    decisions: null,
    questions: ['问?'],
    participants: [{ name: '小林', role: '负责' }, { name: '' }],
    extra: 'should be dropped',
  });

  assert.equal(digest.overview.length, 400);
  assert.deepEqual(digest.highlights, ['a', 'b']);
  assert.equal(digest.tasks.length, 1);
  assert.deepEqual(digest.decisions, []);
  assert.equal(digest.participants.length, 1);
  assert.equal(Object.hasOwn(digest, 'extra'), false);
});
