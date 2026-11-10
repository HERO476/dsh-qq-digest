import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSecret, resolveSecretInfo, secretPath } from '../src/runtime.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'qq-digest-secret-'));
}

test('首次启动生成随机密钥并落盘（不再有源码里的默认常量）', () => {
  const dir = tempDir();
  try {
    const first = resolveSecretInfo({}, dir);
    assert.equal(first.source, 'generated');
    assert.match(first.secret, /^[0-9a-f]{64}$/);
    // 曾经的默认常量：任何人拿到它就能离线算出任意房间的句柄
    assert.notEqual(first.secret, 'qq-digest-local-dev-secret-0123456789');

    // 落盘了，且内容就是这把密钥
    assert.equal(readFileSync(secretPath(dir), 'utf8').trim(), first.secret);

    // 同一个数据目录再解析一次：必须复用（否则每次重启水位线全废）
    const second = resolveSecretInfo({}, dir);
    assert.equal(second.source, 'file');
    assert.equal(second.secret, first.secret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('不同数据目录得到不同密钥（不可跨实例复用）', () => {
  const a = tempDir();
  const b = tempDir();
  try {
    const first = resolveSecretInfo({}, a);
    const second = resolveSecretInfo({}, b);
    assert.notEqual(first.secret, second.secret);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('显式 QQ_DIGEST_SECRET 优先于文件', () => {
  const dir = tempDir();
  try {
    const generated = resolveSecretInfo({}, dir);
    const explicit = 'explicit-secret-at-least-16-chars';
    const info = resolveSecretInfo({ QQ_DIGEST_SECRET: explicit }, dir);
    assert.equal(info.source, 'env');
    assert.equal(info.secret, explicit);
    assert.notEqual(info.secret, generated.secret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('过短的 QQ_DIGEST_SECRET 不被接受（会退回生成的文件密钥）', () => {
  const dir = tempDir();
  try {
    const info = resolveSecretInfo({ QQ_DIGEST_SECRET: 'short' }, dir);
    assert.notEqual(info.secret, 'short');
    assert.equal(info.source, 'generated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSecret 只是 resolveSecretInfo 的取值包装', () => {
  const dir = tempDir();
  try {
    assert.equal(resolveSecret({}, dir), resolveSecretInfo({}, dir).secret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('数据目录不可写时抛 HANDLE_SECRET_UNWRITABLE，而不是退回弱密钥', () => {
  // 用一个「父路径是文件」的目录来制造不可写：不依赖 chmod（Windows 上不可靠）
  const base = tempDir();
  try {
    const blocker = join(base, 'not-a-dir');
    // 先写一个普通文件，再把它当目录用
    writeFileSync(blocker, 'x', 'utf8');
    assert.throws(() => resolveSecretInfo({}, join(blocker, 'nested')), /HANDLE_SECRET_UNWRITABLE/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
