import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { addComment, deleteComment, loadComments, locateLine, runCli, setStatus, storePath } from '../lib/comments.mjs';

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdview-comments-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'doc.md');
  fs.writeFileSync(file, '# 标题\n\n第一段，**加粗**内容。\n\n| 列 | 值 |\n|---|---|\n| a | `code` |\n');
  return { file, dir: path.join(root, 'state') };
}

test('add, resolve, reopen and delete persist outside the document', (t) => {
  const { file, dir } = sandbox(t);
  const before = fs.readFileSync(file, 'utf8');
  const c = addComment(file, { quote: '加粗内容', body: '这里写清楚', heading: '标题' }, { dir });
  assert.equal(loadComments(file, { dir })[0].status, 'open');
  setStatus(file, c.id, 'resolved', { reply: '已改', dir });
  assert.deepEqual(
    [loadComments(file, { dir })[0].status, loadComments(file, { dir })[0].reply],
    ['resolved', '已改'],
  );
  setStatus(file, c.id, 'open', { dir });
  assert.equal(loadComments(file, { dir })[0].resolved_at, null);
  deleteComment(file, c.id, { dir });
  assert.deepEqual(loadComments(file, { dir }), []);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.ok(storePath(file, dir).startsWith(dir));
});

test('empty body and unknown id are rejected', (t) => {
  const { file, dir } = sandbox(t);
  assert.throws(() => addComment(file, { quote: 'x', body: '  ' }, { dir }), /不能为空/);
  assert.throws(() => setStatus(file, 'nope', 'resolved', { dir }), /不存在/);
});

test('symlinked path shares the same comment store', (t) => {
  const { file, dir } = sandbox(t);
  const link = path.join(path.dirname(file), 'link.md');
  fs.symlinkSync(file, link);
  addComment(link, { quote: 'a', body: 'b' }, { dir });
  assert.equal(loadComments(file, { dir }).length, 1);
});

test('locateLine maps rendered text back to markdown source lines', () => {
  const md = '# 标题\n\n第一段，**加粗**内容。\n\n| 列 | 值 |\n|---|---|\n| a | `code` |\n';
  assert.equal(locateLine(md, '加粗内容'), 3);
  assert.equal(locateLine(md, 'acode'), 7);
  assert.equal(locateLine(md, '不存在的文字'), null);
  assert.equal(locateLine(md, ''), null);
});

test('cli lists open comments with line numbers and resolves with reply', (t) => {
  const { file, dir } = sandbox(t);
  const c = addComment(file, { quote: '第一段', body: '改一下' }, { dir });
  let printed = '';
  assert.equal(runCli([file], { dir, out: (s) => { printed = s } }), 0);
  const listed = JSON.parse(printed);
  assert.equal(listed.open, 1);
  assert.equal(listed.comments[0].line, 3);
  runCli([file, '--resolve', c.id, '--reply', '已处理'], { dir, out: () => {} });
  runCli([file], { dir, out: (s) => { printed = s } });
  assert.equal(JSON.parse(printed).comments.length, 0);
  runCli([file, '--all'], { dir, out: (s) => { printed = s } });
  assert.equal(JSON.parse(printed).comments[0].reply, '已处理');
});
