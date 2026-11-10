/**
 * 水位线：每个群记「已摘要到哪一条」，下次只跑增量。
 * 这是避免重复总结的根本机制，不是优化项。
 *
 * 本实现是内存态；需要跨进程保持时用 store-file.js 里的 createFileWatermark。
 */
export function createMemoryWatermark() {
  const marks = new Map();

  return {
    get(key) {
      return marks.has(key) ? marks.get(key) : 0;
    },
    set(key, seq) {
      if (!Number.isFinite(seq) || seq < 0) throw new Error('BAD_SEQ');
      marks.set(key, seq);
    },
    keys() {
      return [...marks.keys()];
    },
  };
}
