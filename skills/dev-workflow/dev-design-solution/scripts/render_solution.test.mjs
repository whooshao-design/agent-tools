// render_solution.mjs 的渲染规则单测：不启动浏览器，只检查生成的 HTML 结构与 F4 匹配函数。
// 运行：node --test skills/dev-workflow/dev-design-solution/scripts/render_solution.test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { changeOf, flowchartNodes, matchRow, parseDirective, renderBody, renderPage, sequenceMessageCount, DEFAULT_VENDOR } from './render_solution.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = fs.readFileSync(path.join(here, 'fixtures/render-sample.md'), 'utf8');

test('changeOf maps the four change words and ignores others', () => {
  assert.equal(changeOf(' 新增 '), 'new');
  assert.equal(changeOf('修改（签名不变）'), 'mod');
  assert.equal(changeOf('删除'), 'del');
  assert.equal(changeOf('现有'), 'keep');
  assert.equal(changeOf('—'), '');
});

test('parseDirective reads node-map pairs and flags unknown directives', () => {
  assert.deepEqual(parseDirective('<!-- render: node-map A=甲; 节点乙=行乙；C = 丙 -->'),
    { nodeMap: { A: '甲', '节点乙': '行乙', C: '丙' } });
  assert.deepEqual(parseDirective('<!-- render: fold-all -->'), { unknown: 'fold-all' });
  assert.equal(parseDirective('<!-- 普通注释 -->'), null);
});

test('flowchartNodes reads labelled nodes of every shape and skips edge labels', () => {
  const src = [
    'flowchart TD',
    '    A[收到任务]:::new --> B{任务已取消}',
    '    B -->|是（跳过）| C([调用 drop(x)])',
    '    B -- 否 --> D[(写库)] --> E["标记 **完成**<br/>并通知"]',
    '    F((圆)) & G{{六边形}} & H[/斜/] --> I>旗]',
    '    J --> A',
    '    A --> 通知[通知前端]',
    '    classDef new fill:#d9f2d9',
    '    A[重复定义不覆盖]',
  ].join('\n');
  assert.deepEqual(flowchartNodes(src), [
    { id: 'A', label: '收到任务' }, { id: 'B', label: '任务已取消' }, { id: 'C', label: '调用 drop(x)' },
    { id: 'D', label: '写库' }, { id: 'E', label: '标记 完成 并通知' }, { id: 'F', label: '圆' },
    { id: 'G', label: '六边形' }, { id: 'H', label: '斜' }, { id: 'I', label: '旗' }, { id: '通知', label: '通知前端' },
  ]);
});

test('sequenceMessageCount counts messages with ASCII or Chinese participant ids and skips other lines', () => {
  const src = [
    'sequenceDiagram',
    '    participant 用户',
    '    participant api as 后端服务',
    '    用户->>api: 提交任务',
    '    api-->>+用户: 返回 ID',
    '    Note over 用户,api: a->>b: 注释里的箭头不算',
    '    %% 用户->>api: 被注释掉的消息不算',
    '    alt 失败',
    '    web-app -x 用户: 超时',
    '    用户 -) api: 异步通知',
    '    end',
  ].join('\n');
  assert.equal(sequenceMessageCount(src), 4);
});

test('matchRow: instruction > exact > substring > dice >= 0.5', () => {
  const rows = ['收到任务', '取消处理', '写入文件 ExportWriter', '标记完成'];
  assert.deepEqual(matchRow({ id: 'C', label: '丢弃任务' }, rows, { C: '取消处理' }), { row: '取消处理', how: 'instruction' });
  assert.deepEqual(matchRow({ id: 'C', label: '丢弃任务' }, rows, { '丢弃任务': '取消处理' }), { row: '取消处理', how: 'instruction' });
  assert.equal(matchRow({ id: 'C', label: '丢弃任务' }, rows, { C: '不存在的行' }), null);
  assert.deepEqual(matchRow({ id: 'A', label: '收到 任务' }, rows), { row: '收到任务', how: 'exact' });
  assert.deepEqual(matchRow({ id: 'D', label: '写入文件' }, rows), { row: '写入文件 ExportWriter', how: 'substring' });
  assert.equal(matchRow({ id: 'E', label: '标记已完成' }, rows).row, '标记完成');
  assert.equal(matchRow({ id: 'X', label: '丢弃任务' }, rows), null);
});

test('renderBody groups sections by template chapters and marks foldable chapter-3 subsections', () => {
  const { body, toc, stats } = renderBody(sample);
  for (const ch of ['1', '2', '3', '4', '5', '6', '7']) assert.match(body, new RegExp(`id="sec-${ch}" [^>]*|data-level="2" data-num="${ch}"`));
  assert.match(body, /data-key="summary"/);
  assert.match(body, /data-num="3.1" data-chapter="3" id="sec-3-1" data-first-sub="1"/);
  assert.equal((body.match(/class="fold"/g) || []).length, 3 + 4 + 3);   // 每个 h3 都带按钮，页面脚本只保留第 3 章的
  assert.equal(toc.length, 8 + 10);   // 摘要 + 第 1～7 章，以及 10 个三级标题
  assert.deepEqual(stats, { sections: 1 + 8 + 10, diagrams: 3, changeTables: 2, implTables: 1, instructionLines: 1 });
});

test('renderBody marks change rows, keeps diagram source and binds F4 links through node-map', () => {
  const { body, f4, warnings } = renderBody(sample);
  assert.equal((body.match(/data-change="new"/g) || []).length, 5);
  assert.equal((body.match(/data-change="mod"/g) || []).length, 2);
  assert.equal((body.match(/data-change="keep"/g) || []).length, 2);
  assert.ok(body.includes('<th class="chg">变更</th>') && body.includes('<td class="chg">新增</td>'));   // 变更列不换行
  assert.match(body, /<figure class="diagram" id="diagram-1" data-kind="sequence" data-messages="5">/);
  assert.match(body, /<\/figure>\s*<ol>/);
  assert.match(body, /<figure class="diagram" id="diagram-3" data-kind="sequence" data-messages="0">/);   // 没有消息的时序图   // 时序图后紧跟编号列表，页面分步时高亮对应项
  assert.ok(body.includes('前端-&gt;&gt;导出服务: 【新增】提交导出任务'));
  assert.deepEqual(f4, [{
    figure: 'diagram-2', section: '3.2 任务执行', nodes: 6, unmatched: [],
    links: { A: '收到任务', B: '任务已取消', C: '取消处理', D: '写入文件', E: '标记完成', '通知': '通知前端' },
  }]);
  assert.deepEqual(warnings, []);
});

test('renderBody keeps IDs on one line in text only, not in code, diagram source or data attributes', () => {
  const md = '# T\n\n## 摘要\n\n见 DEC-001、**CR7-V01** 和 `AC-009`。\n\n1. 松散 AC-004\n\n2. 松散 AC-005\n\n'
    + '```text\nAC-010\n```\n\n## 3. 详细设计\n\n### 3.1 机制\n\n```mermaid\nflowchart TD\n  A[AC-011 收到] --> B[结束]\n```\n\n'
    + '| 步骤 | 变更 | 实现位置 |\n|---|---|---|\n| AC-011 收到 | 新增 | x |\n| 结束 | 现有 | y |\n';
  const { body, f4 } = renderBody(md);
  const wrapped = (id) => `<span class="nowrap">${id}</span>`;
  for (const id of ['DEC-001', 'CR7-V01', 'AC-004', 'AC-005']) assert.ok(body.includes(wrapped(id)), id);
  assert.ok(!body.includes('<span class="nowrap"><span'));   // 松散列表把已渲染的文字再包成段落，不重复包
  assert.ok(body.includes('<code>AC-009</code>') && body.includes('AC-010\n</code></pre>'));
  assert.ok(body.includes('A[AC-011 收到]'));
  assert.ok(body.includes('data-name="AC-011 收到"') && body.includes(`<td>${wrapped('AC-011')} 收到</td>`));
  assert.deepEqual(f4[0].links, { A: 'AC-011 收到', B: '结束' });
});

test('renderPage writes the source fingerprint and loads vendor by protocol', () => {
  const outDir = path.join(here, 'fixtures');
  const { html } = renderPage(sample, { outDir });
  const sha = 'sha256-v1:' + crypto.createHash('sha256').update(sample).digest('hex');
  assert.ok(html.includes(`<meta name="source-sha256" content="${sha}">`));
  assert.ok(html.includes('<meta name="source-version" content="v2">'));
  const rel = path.relative(outDir, DEFAULT_VENDOR).split(path.sep).join('/');
  assert.ok(html.includes(`location.protocol === 'file:' ? ${JSON.stringify(rel)} : '/vendor'`));
  assert.ok(!/<script src=/.test(html));
});
