'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStoryUrl, buildMarkdown, extensionFor } = require('../scripts/fetch_tapd_story');

test('story URL parsing accepts both TAPD URL styles and keeps the 7-digit short ID', () => {
  assert.deepEqual(parseStoryUrl('https://www.tapd.cn/tapd_fe/20061171/story/detail/1120061171001426731'), {
    workspaceId: '20061171', storyId: '1120061171001426731', shortId: '1426731',
  });
  assert.equal(parseStoryUrl('https://www.tapd.cn/20061171/prong/stories/view/1120061171001406306').shortId, '1406306');
});

test('non-story URLs are rejected before a browser starts', () => {
  assert.throws(() => parseStoryUrl('https://www.tapd.cn/20061171/bugtrace/bugs/view/1'), /not a TAPD story URL/);
  assert.throws(() => parseStoryUrl('http://evil.example/tapd.cn/story/detail/1'), /not a TAPD story URL/);
});

test('markdown keeps status label, non-empty custom fields and comments', () => {
  const md = buildMarkdown({
    story: {
      name: 'Demo', status: 'planning', priority: 'High', owner: 'a;b;', creator: 'c',
      custom_field_12: 'x|y', custom_field_13: '',
    },
    shortId: '1426731',
    url: 'https://www.tapd.cn/tapd_fe/1/story/detail/1',
    statusMap: { planning: '待研测评审' },
    labels: { custom_field_12: '目标', custom_field_13: '空字段' },
    descriptionMd: 'body',
    comments: [{ author: 'u', created: '2026-10-15', text: 'line1\nline2' }],
    fetchedAt: '2026-10-16 17:00',
  });
  assert.match(md, /\| 状态 \| 待研测评审（planning） \|/);
  assert.match(md, /\| 处理人 \| a、b \|/);
  assert.match(md, /\| 目标 \| x\\\|y \|/);
  assert.doesNotMatch(md, /空字段/);
  assert.match(md, /- u（2026-10-15）：line1 line2/);
});

test('image extension follows content type', () => {
  assert.equal(extensionFor('image/jpeg'), '.jpg');
  assert.equal(extensionFor('image/png'), '.png');
  assert.equal(extensionFor(''), '.png');
});
