const assert = require('node:assert/strict');
const test = require('node:test');

const { extractMermaidBlocks } = require('../scripts/check_mermaid.js');

test('extracts ``` and ~~~ mermaid fences, indented ones and info words, but not examples inside other code blocks', () => {
  const md = [
    '# T', '',
    '```mermaid', 'flowchart LR', '  A-->B', '```', '',
    '~~~mermaid', 'flowchart LR', '  A[', '~~~', '',
    '````markdown', '```mermaid', 'not a diagram', '```', '````', '',
    '   ```Mermaid title', '   sequenceDiagram', '   A->>B: hi', '   ```', '',
    '```mermaid', 'never closed',
  ].join('\n');
  const blocks = extractMermaidBlocks(md);
  assert.deepEqual(blocks.map((block) => [block.id, block.line]), [['D1', 3], ['D2', 8], ['D3', 19]]);
  assert.equal(blocks[1].code, 'flowchart LR\n  A[');
  assert.equal(blocks[2].code, 'sequenceDiagram\nA->>B: hi', 'indentation of the fence is stripped');
});
