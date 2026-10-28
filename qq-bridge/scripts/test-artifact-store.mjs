#!/usr/bin/env node
// 产物索引（artifact-store）的回归测试。
// 重点覆盖三条安全边界：scope 隔离、sha256 校验、敏感路径拒收。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArtifactStore } from '../src/artifact-store.js';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
const store = createArtifactStore({ dir });
const scope = 'private:123456789';

console.log('== put / get ==');
const content = '这是一份很长的报告正文。'.repeat(400);
const entry = store.put({ desc: '测试报告', content, scope, kind: 'text' });
check('写入返回 id', /^art_/.test(entry.id));
check('字节数正确', entry.bytes === Buffer.byteLength(content));
check('sha256 是 64 位', /^[0-9a-f]{64}$/.test(entry.sha256));

const got = store.get(entry.id, { scope });
check('取回内容一致', got.text === content);
check('未截断标记', got.truncated === false);

console.log('\n== 隔离与校验 ==');
{
  let err = '';
  try { store.get(entry.id, { scope: 'group:999' }); } catch (e) { err = e.message; }
  check('scope 不符被拒', err.includes('不属于当前会话'), err);
}
{
  // 篡改正文：必须失败，而不是把改过的内容当原文返回。
  const file = path.join(dir, entry.file);
  const orig = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([orig, Buffer.from('篡改')]));
  let err = '';
  try { store.get(entry.id, { scope }); } catch (e) { err = e.message; }
  check('篡改后 sha256 不匹配被拒', err.includes('已被改动'), err);
  fs.writeFileSync(file, orig);
}
{
  let err = '';
  try { store.put({ desc: 'x', scope, sourcePath: path.join(os.homedir(), '.ssh', 'id_rsa') }); }
  catch (e) { err = e.message; }
  check('敏感路径被拒', err.includes('拒绝归档敏感路径'), err);
}
{
  let err = '';
  try { store.put({ desc: 'x', scope }); } catch (e) { err = e.message; }
  check('缺 content/path 被拒', err.includes('至少给一个'), err);
}
{
  let err = '';
  try { store.put({ desc: '', content: 'y', scope }); } catch (e) { err = e.message; }
  check('空 desc 被拒', err.includes('desc 不能为空'), err);
}

console.log('\n== list ==');
store.put({ desc: '第二份', content: 'abc', scope });
store.put({ desc: '群里的', content: 'abc', scope: 'group:1' });
const mine = store.list({ scope });
check('只列本会话', mine.every((e) => e.desc !== '群里的'), JSON.stringify(mine.map((e) => e.desc)));
check('按时间倒序', mine[0].desc === '第二份');
check('列表不带正文', mine.every((e) => !('text' in e)));
check('stats 统计', store.stats().count === 3);

console.log('\n== 截断 ==');
{
  const big = '字'.repeat(20000);
  const e2 = store.put({ desc: '超长', content: big, scope });
  const g2 = store.get(e2.id, { scope, maxChars: 100 });
  check('超长被截断', g2.truncated === true && g2.text.length === 100);
  check('给出总字数', g2.totalChars === 20000);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);