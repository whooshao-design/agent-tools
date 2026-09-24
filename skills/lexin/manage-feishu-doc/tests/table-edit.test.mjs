import assert from "node:assert/strict";
import test from "node:test";

import { editTable, mergedRegions, parseIndexRange, readTable } from "../scripts/feishu_doc.mjs";

// 一张表的 documentBlock.list 形态：单元格引用文本子块，property 带 merge_info（行优先、每格一项）和列宽
function tableBlocks(rows) {
  const columnSize = rows[0].length;
  const blocks = [];
  const cells = [];
  rows.forEach((row, r) => row.forEach((value, c) => {
    const cellId = `cell-${r}-${c}`;
    blocks.push({ block_id: `text-${r}-${c}`, block_type: 2, parent_id: cellId, text: { elements: [{ text_run: { content: value } }] } });
    blocks.push({ block_id: cellId, block_type: 32, parent_id: "table-1", children: [`text-${r}-${c}`] });
    cells.push(cellId);
  }));
  const property = {
    row_size: rows.length,
    column_size: columnSize,
    column_width: Array(columnSize).fill(120),
    header_row: true,
    merge_info: cells.map(() => ({ row_span: 1, col_span: 1 })),
  };
  blocks.push({ block_id: "table-1", block_type: 31, parent_id: "doc", children: cells, table: { property, cells } });
  return blocks;
}

// 按 2026-09-23 实测的服务端行为模拟 patch：合并把内容按行拼进左上角，拆分只认左上角
// concurrent：第一次读表之后，别人往表里插的一行（模拟查评论期间的并发改动）
function fakeTable(rows, { comments = [], concurrent = null } = {}) {
  let blocks = tableBlocks(rows);
  let lists = 0;
  const patches = [];
  const seenTokens = new Set();
  const table = () => blocks.find((block) => block.block_id === "table-1");
  const text = (cellId) => blocks.find((block) => block.parent_id === cellId && block.block_type === 2);
  const transport = {
    async call(name, args) {
      if (name === "docx.v1.documentBlock.list") {
        if (concurrent && (lists += 1) === 2) blocks = typeof concurrent === "function" ? concurrent(blocks) : tableBlocks(concurrent);
        return { items: structuredClone(blocks) };
      }
      if (name === "drive.v1.fileComment.list") return { items: comments, has_more: false };
      if (name !== "docx.v1.documentBlock.patch") throw new Error(`unexpected call ${name}`);
      // 飞书按 client_token 去重：重复的 token 返回成功但不执行（实测）
      if (seenTokens.has(args.params.client_token)) return {};
      seenTokens.add(args.params.client_token);
      patches.push(args.data);
      const { property, cells } = table().table;
      const columns = property.column_size;
      const at = (r, c) => r * columns + c;
      const { delete_table_rows: del, merge_table_cells: merge, unmerge_table_cells: unmerge, update_table_property: width } = args.data;
      if (del) {
        const removed = new Set(cells.slice(del.row_start_index * columns, del.row_end_index * columns));
        blocks = blocks.filter((block) => !removed.has(block.block_id) && !removed.has(block.parent_id));
        cells.splice(del.row_start_index * columns, (del.row_end_index - del.row_start_index) * columns);
        property.merge_info.splice(del.row_start_index * columns, (del.row_end_index - del.row_start_index) * columns);
        property.row_size -= del.row_end_index - del.row_start_index;
      }
      if (merge) {
        const joined = [];
        for (let r = merge.row_start_index; r < merge.row_end_index; r += 1) {
          for (let c = merge.column_start_index; c < merge.column_end_index; c += 1) {
            const block = text(cells[at(r, c)]);
            joined.push(block.text.elements[0].text_run.content);
            block.text.elements[0].text_run.content = "";
          }
        }
        text(cells[at(merge.row_start_index, merge.column_start_index)]).text.elements[0].text_run.content = joined.join("");
        property.merge_info[at(merge.row_start_index, merge.column_start_index)] = {
          row_span: merge.row_end_index - merge.row_start_index,
          col_span: merge.column_end_index - merge.column_start_index,
        };
      }
      if (unmerge) property.merge_info[at(unmerge.row_index, unmerge.column_index)] = { row_span: 1, col_span: 1 };
      if (width) property.column_width[width.column_index] = width.column_width;
      return {};
    },
  };
  return { transport, patches, rows: () => readTable(blocks, "table-1").rows, property: () => table().table.property };
}

const ROWS = [["环境", "地址", "备注"], ["开发", "dev", "一"], ["测试", "test", "二"], ["生产", "prod", "三"]];
const edit = (fake, options) => editTable(fake.transport, "D1", { tableId: "table-1", ...options });

test("row and column numbers are 0-based, a-b includes both ends", () => {
  assert.deepEqual(parseIndexRange("1-2", "rows", 4), { start: 1, end: 3 });
  assert.deepEqual(parseIndexRange("3", "rows", 4), { start: 3, end: 4 });
  for (const bad of ["4", "2-1", "a", "", "-1"]) {
    assert.throws(() => parseIndexRange(bad, "rows", 4), (error) => error.code === "INVALID_ARGUMENT", bad);
  }
  const property = { column_size: 3, merge_info: [{ row_span: 1, col_span: 1 }, { row_span: 2, col_span: 2 }, {}, {}, {}, {}] };
  assert.deepEqual(mergedRegions(property), [{ row: 0, column: 1, rowSpan: 2, colSpan: 2 }]);
});

test("delete-rows previews, deletes the rows and verifies what is left", async () => {
  const fake = fakeTable(ROWS);
  const preview = await edit(fake, { op: "delete-rows", rows: "1-2", dryRun: true });
  assert.deepEqual([preview.status, preview.removedRows], ["dry_run", [["开发", "dev", "一"], ["测试", "test", "二"]]]);
  assert.equal(fake.patches.length, 0);
  const done = await edit(fake, { op: "delete-rows", rows: "1-2" });
  assert.deepEqual([done.status, done.rowSize], ["updated", 2]);
  assert.deepEqual(fake.patches, [{ delete_table_rows: { row_start_index: 1, row_end_index: 3 } }]);
  assert.deepEqual(fake.rows(), [ROWS[0], ROWS[3]]);
  await assert.rejects(edit(fake, { op: "delete-rows", rows: "0-1" }), (error) => error.code === "INVALID_ARGUMENT" && /全部行/.test(error.message));
});

test("delete-rows stops on comments inside the rows and on merged cells that stick out of the range", async () => {
  const comments = [{ comment_id: "c1", quote: "二", is_solved: false, is_whole: false, extra: { content_anchor_id: "text-2-2" } }];
  const blocked = await edit(fakeTable(ROWS, { comments }), { op: "delete-rows", rows: "2" });
  assert.deepEqual([blocked.status, blocked.blockers[0].check], ["blocked", "open_comments"]);
  assert.equal((await edit(fakeTable(ROWS, { comments }), { op: "delete-rows", rows: "3" })).status, "updated", "comments elsewhere do not block");
  assert.equal((await edit(fakeTable(ROWS, { comments }), { op: "delete-rows", rows: "2", acceptCommentLoss: true })).status, "updated");

  const merged = fakeTable(ROWS);
  await edit(merged, { op: "merge", rows: "1-2", cols: "2" });
  await assert.rejects(edit(merged, { op: "delete-rows", rows: "2" }), (error) => error.code === "MERGED_CELLS_IN_RANGE");
  assert.equal((await edit(merged, { op: "delete-rows", rows: "1-2" })).status, "updated", "a merge fully inside the range goes with it");
});

test("merge warns that contents are joined into the top-left cell and refuses partial overlaps", async () => {
  const fake = fakeTable(ROWS);
  const preview = await edit(fake, { op: "merge", rows: "1-2", cols: "2", dryRun: true });
  assert.equal(preview.mergedText, "一二");
  assert.match(preview.warnings[0], /2 个格有内容/);
  const done = await edit(fake, { op: "merge", rows: "1-2", cols: "2" });
  assert.equal(done.status, "updated");
  assert.deepEqual(fake.rows().map((row) => row[2]), ["备注", "一二", "", "三"]);
  await assert.rejects(edit(fake, { op: "merge", rows: "2-3", cols: "2" }), (error) => error.code === "MERGE_OVERLAP");
  await assert.rejects(edit(fake, { op: "merge", rows: "3", cols: "0" }), (error) => error.code === "INVALID_ARGUMENT");
});

test("unmerge finds the region's top-left cell, since Feishu ignores any other cell", async () => {
  const fake = fakeTable(ROWS);
  await edit(fake, { op: "merge", rows: "1-2", cols: "1-2" });
  fake.patches.length = 0;
  const done = await edit(fake, { op: "unmerge", row: "2", col: "2" });
  assert.equal(done.status, "updated");
  assert.deepEqual(fake.patches, [{ unmerge_table_cells: { row_index: 1, column_index: 1 } }]);
  assert.deepEqual(mergedRegions(fake.property()), []);
  await assert.rejects(edit(fake, { op: "unmerge", row: "3", col: "0" }), (error) => error.code === "NOT_MERGED");
});

test("widths patches only the columns that change and keeps * columns", async () => {
  const fake = fakeTable(ROWS);
  const done = await edit(fake, { op: "widths", widths: "*,300,120" });
  assert.deepEqual(done.changes, [{ column: 1, from: 120, to: 300 }]);
  assert.deepEqual(fake.patches, [{ update_table_property: { column_index: 1, column_width: 300 } }]);
  assert.equal((await edit(fake, { op: "widths", widths: "*,300,*" })).status, "unchanged");
  await assert.rejects(edit(fake, { op: "widths", widths: "40,*,*" }), (error) => error.code === "INVALID_ARGUMENT" && /最小 50/.test(error.message));
  await assert.rejects(edit(fake, { op: "widths", widths: "100,100" }), (error) => error.code === "INVALID_ARGUMENT");
  await assert.rejects(edit(fake, { op: "split" }), (error) => error.code === "INVALID_ARGUMENT");
});

test("repeating an earlier operation is applied again, not swallowed as a duplicate request", async () => {
  const fake = fakeTable(ROWS);
  await edit(fake, { op: "merge", rows: "1-2", cols: "0" });
  await edit(fake, { op: "unmerge", row: "1", col: "0" });
  assert.equal((await edit(fake, { op: "merge", rows: "1-2", cols: "0" })).status, "updated");
  await edit(fake, { op: "widths", widths: "200,*,*" });
  await edit(fake, { op: "widths", widths: "120,*,*" });
  assert.equal((await edit(fake, { op: "widths", widths: "200,*,*" })).status, "updated");
});

test("widths for several columns go through, and a table changed after the read is not written", async () => {
  const fake = fakeTable(ROWS);
  const done = await edit(fake, { op: "widths", widths: "200,300,*" });
  assert.deepEqual([done.status, fake.property().column_width], ["updated", [200, 300, 120]]);

  const inserted = [ROWS[0], ["新", "x", "带评论"], ...ROWS.slice(1)];
  const racing = fakeTable(ROWS, { concurrent: inserted });
  await assert.rejects(edit(racing, { op: "delete-rows", rows: "1" }), (error) => error.code === "TABLE_CHANGED_DURING_EDIT");
  assert.equal(racing.patches.length, 0);
});

test("a cell edited or a cell paragraph recreated after the read also stops the write", async () => {
  const edited = [ROWS[0], ["开发", "dev", "一（改）"], ...ROWS.slice(2)];
  const contentRace = fakeTable(ROWS, { concurrent: edited });
  await assert.rejects(edit(contentRace, { op: "delete-rows", rows: "1" }), (error) => error.code === "TABLE_CHANGED_DURING_EDIT");
  const recreate = (blocks) => blocks.map((block) => {
    if (block.block_id === "text-1-2") return { ...block, block_id: "text-1-2b" };
    if (block.block_id === "cell-1-2") return { ...block, children: ["text-1-2b"] };
    return block;
  });
  const childRace = fakeTable(ROWS, { concurrent: recreate });
  await assert.rejects(edit(childRace, { op: "delete-rows", rows: "1" }), (error) => error.code === "TABLE_CHANGED_DURING_EDIT");
  assert.equal(contentRace.patches.length + childRace.patches.length, 0);
});

test("a list item inside a cell edited after the read also stops the write", async () => {
  const withList = (blocks) => blocks.map((block) => (block.block_id === "cell-1-2" ? { ...block, children: [...block.children, "bullet-1-2"] } : block))
    .concat([{ block_id: "bullet-1-2", block_type: 12, parent_id: "cell-1-2", bullet: { elements: [{ text_run: { content: "待确认" } }] } }]);
  const fake = fakeTable(ROWS, {
    concurrent: (blocks) => withList(blocks).map((block) => (block.block_id === "bullet-1-2" ? { ...block, bullet: { elements: [{ text_run: { content: "新增方案" } }] } } : block)),
  });
  // 第一次读到的表已经带着列表项（内容「待确认」）
  const original = fake.transport.call;
  let first = true;
  fake.transport.call = async (name, args) => {
    const value = await original(name, args);
    if (name === "docx.v1.documentBlock.list" && first) {
      first = false;
      return { items: withList(value.items) };
    }
    return value;
  };
  await assert.rejects(edit(fake, { op: "delete-rows", rows: "1" }), (error) => error.code === "TABLE_CHANGED_DURING_EDIT");
  assert.equal(fake.patches.length, 0);
});

test("only a link target changed in a cell after the read still stops the write", async () => {
  const link = (url) => (blocks) => blocks.map((block) => (block.block_id === "text-1-2"
    ? { ...block, text: { elements: [{ text_run: { content: "一", text_element_style: { link: { url } } } }] } }
    : block));
  const fake = fakeTable(ROWS, { concurrent: link("https%3A%2F%2Fexample.com%2Fapproved") });
  const original = fake.transport.call;
  let first = true;
  fake.transport.call = async (name, args) => {
    const value = await original(name, args);
    if (name === "docx.v1.documentBlock.list" && first) {
      first = false;
      return { items: link("https%3A%2F%2Fexample.com%2Fdraft")(value.items) };
    }
    return value;
  };
  await assert.rejects(edit(fake, { op: "delete-rows", rows: "1" }), (error) => error.code === "TABLE_CHANGED_DURING_EDIT");
  assert.equal(fake.patches.length, 0);
});
