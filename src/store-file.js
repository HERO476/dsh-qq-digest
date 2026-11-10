/**
 * 摘要落盘：<dataDir>/digests.jsonl 与 <dataDir>/watermarks.json。
 *
 * 落盘只写白名单字段（RECORD_FIELDS），写入代码里**不存在**「消息原文」和
 * 「原始会话 id」这两条路 —— 不是靠过滤，而是结构上不可能。
 *
 * 损坏行启动时跳过并计数，不因为一行坏掉就丢整份历史。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RECORD_FIELDS, fail } from './core/store.js';

export const DIGEST_FILE = 'digests.jsonl';
export const WATERMARK_FILE = 'watermarks.json';

export function createFileStore({ dir, now = () => new Date().toISOString() } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) throw new Error('FILE_STORE_MISSING_DIR');
  mkdirSync(dir, { recursive: true });

  const file = join(dir, DIGEST_FILE);
  const entries = [];
  let skippedLines = 0;
  let allowed = new Set();

  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.roomHandle === 'string') entries.push(parsed);
        else skippedLines += 1;
      } catch {
        skippedLines += 1;
      }
    }
  }

  return {
    dir,
    file,
    skippedLines,

    bindAllowed(handles) {
      allowed = new Set(Array.isArray(handles) ? handles : []);
    },

    put(record) {
      if (!record || typeof record !== 'object') throw fail('STORE_BAD_RECORD');
      if (!allowed.has(record.roomHandle)) throw fail('STORE_SCOPE_DENIED');

      const p = record.provenance;
      if (!p || typeof p.seqFrom !== 'number' || typeof p.seqTo !== 'number') {
        throw fail('STORE_PROVENANCE_REQUIRED');
      }

      // 白名单重建：只有 RECORD_FIELDS 里的键会被写下去。
      const draft = {
        roomHandle: record.roomHandle,
        roomTitle: typeof record.roomTitle === 'string' ? record.roomTitle : null,
        digest: sanitizeDigest(record.digest),
        provenance: {
          roomHandle: record.roomHandle,
          seqFrom: p.seqFrom,
          seqTo: p.seqTo,
          ...(typeof p.messageCount === 'number' ? { messageCount: p.messageCount } : {}),
        },
        trigger: record.trigger === 'scheduled' ? 'scheduled' : 'manual',
        createdAt: record.createdAt ?? now(),
      };

      const stored = Object.freeze(
        Object.fromEntries(RECORD_FIELDS.filter((key) => key in draft).map((key) => [key, draft[key]])),
      );

      appendFileSync(file, `${JSON.stringify(stored)}\n`, 'utf8');
      entries.push(stored);
      return stored;
    },

    all() {
      return entries.slice();
    },

    latest(roomHandle) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index].roomHandle === roomHandle) return entries[index];
      }
      return null;
    },

    latestPerRoom() {
      const map = new Map();
      for (const entry of entries) map.set(entry.roomHandle, entry);
      return [...map.values()];
    },

    dump() {
      return JSON.stringify(entries);
    },
  };
}

/** 摘要对象的字段也重建一遍：防止摘要器（尤其模型返回）塞进来额外字段。 */
function sanitizeDigest(digest) {
  const source = digest && typeof digest === 'object' && !Array.isArray(digest) ? digest : {};
  return {
    summarizer: source.summarizer === 'llm' ? 'llm' : 'heuristic',
    overview: typeof source.overview === 'string' ? source.overview.slice(0, 400) : '',
    highlights: strings(source.highlights, 8),
    tasks: Array.isArray(source.tasks)
      ? source.tasks.slice(0, 8).map((task) => ({
          what: typeof task?.what === 'string' ? task.what.slice(0, 200) : '',
          owner: typeof task?.owner === 'string' ? task.owner.slice(0, 40) : '未指定',
          due: typeof task?.due === 'string' ? task.due.slice(0, 40) : null,
        })).filter((task) => task.what !== '')
      : [],
    decisions: strings(source.decisions, 8),
    questions: strings(source.questions, 8),
    participants: Array.isArray(source.participants)
      ? source.participants.slice(0, 10).map((person) => ({
          name: typeof person?.name === 'string' ? person.name.slice(0, 40) : '',
          ...(typeof person?.messages === 'number' ? { messages: person.messages } : {}),
          ...(typeof person?.role === 'string' ? { role: person.role.slice(0, 60) } : {}),
        })).filter((person) => person.name !== '')
      : [],
    stats: source.stats && typeof source.stats === 'object' ? source.stats : undefined,
  };
}

function strings(value, max) {
  return Array.isArray(value)
    ? value.slice(0, max).map((item) => (typeof item === 'string' ? item.slice(0, 200) : '')).filter((item) => item !== '')
    : [];
}

/**
 * 水位线落盘：跨进程保持「每个群摘要到哪一条」。
 * 原子写（tmp + rename），坏文件当作空表重来（宁可多跑一轮，不漏读）。
 */
export function createFileWatermark({ dir } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) throw new Error('WATERMARK_MISSING_DIR');
  mkdirSync(dir, { recursive: true });

  const file = join(dir, WATERMARK_FILE);
  const marks = new Map();

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      for (const [key, value] of Object.entries(parsed?.marks ?? {})) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) marks.set(key, value);
      }
    } catch {
      // 坏文件 = 空表；下一次运行会全量重算，不会漏。
    }
  }

  function readFromDisk() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const disk = new Map();
      for (const [key, value] of Object.entries(parsed?.marks ?? {})) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) disk.set(key, value);
      }
      return disk;
    } catch {
      return null;
    }
  }

  function flush() {
    const payload = { version: 1, marks: Object.fromEntries(marks) };
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  }

  return {
    file,
    get(key) {
      return marks.has(key) ? marks.get(key) : 0;
    },
    set(key, seq) {
      if (!Number.isFinite(seq) || seq < 0) throw new Error('BAD_SEQ');
      // 跨进程合并：MCP 进程和 DSH 宿主进程各有一份内存表，
      // 直接整表回写会让对方刚推进的水位线被覆盖（表现为重复摘要或漏读）。
      // 因此每次写之前先读磁盘、取较大值，再整表落盘。
      const disk = readFromDisk();
      if (disk) {
        for (const [otherKey, otherSeq] of disk) {
          const current = marks.get(otherKey);
          if (current === undefined || otherSeq > current) marks.set(otherKey, otherSeq);
        }
      }
      const merged = Math.max(marks.get(key) ?? 0, seq);
      marks.set(key, merged);
      flush();
      return merged;
    },
    keys() {
      return [...marks.keys()];
    },
  };
}
