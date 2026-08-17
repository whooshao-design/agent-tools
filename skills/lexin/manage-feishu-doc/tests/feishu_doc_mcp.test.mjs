import assert from "node:assert/strict";
import test from "node:test";

import {
  assessAuthorization,
  buildManagedBlocks,
  cellBlockTarget,
  classifyFailure,
  deterministicClientToken,
  diffTable,
  findManagedSections,
  listTables,
  parseTarget,
  parseWhoamiOutput,
  readTable,
  requiredScopes,
  syncTable,
  writeJson,
} from "../scripts/feishu_doc_mcp.mjs";

// Mirrors what docx.v1.documentBlock.list returns: a flat block array where
// table cells reference their children by id.
function buildTableDoc(rows, { fillerParagraph = true } = {}) {
  const columnSize = rows[0].length;
  const blocks = [];
  const cells = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      const cellId = `cell-${rowIndex}-${columnIndex}`;
      const children = [];
      if (fillerParagraph) {
        children.push(`text-${rowIndex}-${columnIndex}-filler`);
        blocks.push({
          block_id: `text-${rowIndex}-${columnIndex}-filler`,
          block_type: 2,
          parent_id: cellId,
          text: { elements: [{ text_run: { content: "" } }] },
        });
      }
      children.push(`text-${rowIndex}-${columnIndex}`);
      blocks.push({
        block_id: `text-${rowIndex}-${columnIndex}`,
        block_type: 2,
        parent_id: cellId,
        text: { elements: [{ text_run: { content: value, text_element_style: { bold: rowIndex === 0 } } }] },
      });
      cells.push(cellId);
      blocks.push({ block_id: cellId, block_type: 32, parent_id: "table-1", children });
    });
  });
  blocks.push({
    block_id: "table-1",
    block_type: 31,
    parent_id: "doc",
    children: cells,
    table: { property: { row_size: rows.length, column_size: columnSize }, cells },
  });
  return blocks;
}

test("parseTarget accepts lexin docx and strips query", () => {
  assert.deepEqual(
    parseTarget("https://lexin.feishu.cn/docx/Ui4gdjY1EoLmjbxA7Yscntu6nYb?from=copy"),
    { host: "lexin.feishu.cn", kind: "docx", token: "Ui4gdjY1EoLmjbxA7Yscntu6nYb", source: "url" },
  );
});

test("parseTarget accepts lexin wiki and rejects unrelated hosts", () => {
  assert.equal(parseTarget("https://lexin.feishu.cn/wiki/DrOFwKwq0iiKqvk1603cKrCmnHk").kind, "wiki");
  assert.throws(
    () => parseTarget("https://ledocs.lexincloud.com/doc/f0a48f0fda82984d401987bfdcf37829"),
    (error) => error.code === "UNSUPPORTED_HOST",
  );
});

test("requiredScopes adds wiki permission only for wiki targets", () => {
  const docx = requiredScopes("write-json", { kind: "docx" });
  const wiki = requiredScopes("write-json", { kind: "wiki" });
  assert.ok(docx.includes("docx:document"));
  assert.ok(!docx.includes("wiki:wiki:readonly"));
  assert.ok(wiki.includes("wiki:wiki:readonly"));
});

test("parseWhoamiOutput does not expose token and detects refresh token", () => {
  const output = `AccessToken Expired: false\n{
    "token": "masked-token",
    "scopes": ["docx:document", "offline_access"],
    "expiresAt": 4102444800,
    "extra": {"refreshToken": "masked-refresh", "appSecret": "masked-secret"}
  }`;
  assert.deepEqual(parseWhoamiOutput(output), {
    active: true,
    expired: false,
    scopes: ["docx:document", "offline_access"],
    hasRefreshToken: true,
    expiresAt: 4102444800,
  });
});

test("authorization preflight returns all missing scopes at once", () => {
  const result = assessAuthorization(
    { active: true, expired: false, scopes: ["offline_access"], hasRefreshToken: true },
    "write-json",
    { kind: "wiki" },
  );
  assert.equal(result.failureClass, "OAUTH_SCOPE_MISSING");
  assert.deepEqual(result.missingScopes, ["docx:document", "docx:document:readonly", "wiki:wiki:readonly"]);
});

test("authorization preflight distinguishes missing and expired sessions", () => {
  assert.equal(
    assessAuthorization({ active: false, scopes: [] }, "read", { kind: "docx" }).failureClass,
    "AUTH_REQUIRED",
  );
  assert.equal(
    assessAuthorization(
      {
        active: true,
        expired: true,
        scopes: ["docx:document:readonly"],
        hasRefreshToken: false,
      },
      "read",
      { kind: "docx" },
    ).failureClass,
    "TOKEN_EXPIRED",
  );
});

test("classifyFailure extracts exact scope from Feishu 99991679", () => {
  const result = classifyFailure({ code: 99991679, permission_violations: [{ subject: "docx:document.block:convert" }] });
  assert.equal(result.failureClass, "OAUTH_SCOPE_MISSING");
  assert.deepEqual(result.missingScopes, ["docx:document.block:convert"]);
});

test("classifyFailure digs scopes out of Lark's escaped rawErrorText", () => {
  // Shape returned by lark-mcp: the real payload is an escaped JSON string.
  const raw = JSON.stringify({
    errorCode: 99991679,
    rawErrorText: JSON.stringify({
      code: 99991679,
      error: {
        permission_violations: [
          { subject: "drive:drive", type: "action_privilege_required" },
          { subject: "space:document:delete", type: "action_privilege_required" },
        ],
      },
    }),
  });
  const result = classifyFailure(new Error(raw));
  assert.equal(result.failureClass, "OAUTH_SCOPE_MISSING");
  assert.deepEqual(result.missingScopes, ["drive:drive", "space:document:delete"]);
});

test("classifyFailure distinguishes app publication, ACL, and tool loading", () => {
  assert.equal(classifyFailure("OAuth error 20027").failureClass, "APP_PERMISSION_NOT_PUBLISHED");
  assert.equal(classifyFailure("403 forbidden: no permission").failureClass, "DOCUMENT_ACCESS_DENIED");
  assert.equal(classifyFailure("MCP tool not found: docx_v1_documentBlock_patch").failureClass, "MCP_TOOL_MISSING");
  const missingTool = new Error("MCP tool 未加载");
  missingTool.code = "MCP_TOOL_MISSING";
  assert.equal(classifyFailure(missingTool).failureClass, "MCP_TOOL_MISSING");
});

test("deterministicClientToken is stable UUID-shaped and content-sensitive", () => {
  const first = deterministicClientToken("doc", "section", "hash");
  assert.equal(first, deterministicClientToken("doc", "section", "hash"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, deterministicClientToken("doc", "section", "other"));
});

test("managed JSON section is found and verified by exact SHA-256", () => {
  const content = '{\n  "name": "PackageAllInfo"\n}\n';
  const managed = buildManagedBlocks("package-all-info", content, "PackageAllInfo");
  const sections = findManagedSections(managed.blocks, "package-all-info");
  assert.equal(sections.length, 1);
  assert.equal(sections[0].actualHash, managed.contentHash);
  assert.equal(sections[0].verified, true);

  managed.blocks[2].code.elements[0].text_run.content = "tampered";
  assert.equal(findManagedSections(managed.blocks, "package-all-info")[0].verified, false);
});

test("readTable joins every text child so filler paragraphs stay invisible", () => {
  const blocks = buildTableDoc([
    ["ID", "名称"],
    ["M1000", "调用数"],
  ]);
  const table = readTable(blocks, "table-1");
  assert.deepEqual(table.rows, [
    ["ID", "名称"],
    ["M1000", "调用数"],
  ]);
  assert.equal(table.rowSize, 2);
  assert.equal(table.columnSize, 2);
  assert.deepEqual(table.cellBlockCounts[1], [2, 2]);
  assert.deepEqual(listTables(blocks), [{ blockId: "table-1", rowSize: 2, columnSize: 2 }]);
});

test("readTable rejects non-table blocks and broken shapes", () => {
  const blocks = buildTableDoc([["a"]]);
  assert.throws(() => readTable(blocks, "cell-0-0"), (error) => error.code === "NOT_A_TABLE");
  assert.throws(() => readTable(blocks, "missing"), (error) => error.code === "BLOCK_NOT_FOUND");
  const broken = structuredClone(blocks);
  broken.at(-1).table.property.row_size = 5;
  assert.throws(() => readTable(broken, "table-1"), (error) => error.code === "INVALID_TABLE_SHAPE");
});

test("diffTable reports only changed cells", () => {
  const current = [["a", "b"], ["c", "d"]];
  assert.deepEqual(diffTable(current, [["a", "b"], ["c", "d"]]), []);
  assert.deepEqual(diffTable(current, [["a", "b"], ["c", "z"]]), [
    { row: 1, column: 1, from: "d", to: "z" },
  ]);
  // Rows beyond the current table read as missing rather than throwing.
  assert.deepEqual(diffTable(current, [["a", "b"], ["c", "d"], ["e", "f"]]).length, 2);
});

test("cellBlockTarget follows the shape of existing body rows, not the header", () => {
  assert.equal(cellBlockTarget([[9, 9], [2, 2], [2, 2]], 3), 2);
  assert.equal(cellBlockTarget([[1, 1], [1, 1]], 2), 1);
  assert.equal(cellBlockTarget([[3, 3]], 1), 1);
});

test("syncTable appends rows, pads new cells, and writes only differing cells", async () => {
  let blocks = buildTableDoc([
    ["ID", "名称"],
    ["M1000", "调用数"],
  ]);
  const calls = [];
  const mcp = {
    async call(name, args) {
      if (name === "docx.v1.documentBlock.list") return { items: structuredClone(blocks) };
      if (name === "docx.v1.documentBlock.patch") {
        calls.push("insert_row");
        const table = blocks.at(-1);
        const rowIndex = table.table.property.row_size;
        for (let column = 0; column < table.table.property.column_size; column += 1) {
          const cellId = `cell-${rowIndex}-${column}`;
          const textId = `text-${rowIndex}-${column}`;
          // insert_table_row creates a cell holding exactly one empty paragraph.
          blocks.push({ block_id: textId, block_type: 2, parent_id: cellId, text: { elements: [{ text_run: { content: "" } }] } });
          blocks.push({ block_id: cellId, block_type: 32, parent_id: "table-1", children: [textId] });
          table.table.cells.push(cellId);
        }
        table.table.property.row_size += 1;
        return { document_revision_id: 10 };
      }
      if (name === "docx.v1.documentBlockChildren.create") {
        calls.push("pad");
        const cell = blocks.find((block) => block.block_id === args.path.block_id);
        const padId = `${cell.block_id}-pad`;
        blocks.push({ block_id: padId, block_type: 2, parent_id: cell.block_id, text: { elements: [{ text_run: { content: "" } }] } });
        cell.children.splice(args.data.index, 0, padId);
        return { document_revision_id: 11 };
      }
      if (name === "docx.v1.documentBlock.batchUpdate") {
        calls.push(`batch:${args.data.requests.length}`);
        for (const request of args.data.requests) {
          const block = blocks.find((item) => item.block_id === request.block_id);
          block.text.elements = request.update_text_elements.elements;
        }
        return { document_revision_id: 12 };
      }
      throw new Error(`unexpected tool: ${name}`);
    },
  };

  const desired = [
    ["ID", "名称"],
    ["M1000", "调用数"],
    ["M1001", "通过数"],
  ];
  const result = await syncTable(mcp, "doc-token", { tableId: "table-1", rows: desired });
  assert.equal(result.status, "updated");
  assert.equal(result.verified, true);
  assert.equal(result.rowsToAppend, 1);
  assert.equal(result.cellsWritten, 2, "只写新增行的 2 个格，不动既有行");
  assert.equal(result.cellBlocksPadded, 2, "新行每格补一个空段落以对齐行高");
  assert.deepEqual(readTable(blocks, "table-1").rows, desired);
  assert.deepEqual(calls.filter((item) => item.startsWith("batch")), ["batch:2"]);

  // Header style survives because unchanged cells are never rewritten.
  const header = blocks.find((block) => block.block_id === "text-0-0");
  assert.equal(header.text.elements[0].text_run.text_element_style.bold, true);

  calls.length = 0;
  const retry = await syncTable(mcp, "doc-token", { tableId: "table-1", rows: desired });
  assert.equal(retry.status, "unchanged");
  assert.deepEqual(calls, []);
});

test("syncTable refuses shrinking row counts and column mismatch", async () => {
  const blocks = buildTableDoc([
    ["ID", "名称"],
    ["M1000", "调用数"],
  ]);
  const mcp = { async call() { return { items: structuredClone(blocks) }; } };
  await assert.rejects(
    () => syncTable(mcp, "doc-token", { tableId: "table-1", rows: [["ID", "名称"]] }),
    (error) => error.code === "ROW_COUNT_SHRINK",
  );
  await assert.rejects(
    () => syncTable(mcp, "doc-token", { tableId: "table-1", rows: [["a"], ["b"]] }),
    (error) => error.code === "COLUMN_COUNT_MISMATCH",
  );
});

test("syncTable dry run reports the plan without calling any write tool", async () => {
  const blocks = buildTableDoc([
    ["ID", "名称"],
    ["M1000", "调用数"],
  ]);
  const seen = [];
  const mcp = {
    async call(name) {
      seen.push(name);
      return { items: structuredClone(blocks) };
    },
  };
  const result = await syncTable(mcp, "doc-token", {
    tableId: "table-1",
    rows: [
      ["ID", "名称"],
      ["M1000", "调用次数"],
      ["M1001", "通过数"],
    ],
    dryRun: true,
  });
  assert.equal(result.status, "dry_run");
  assert.equal(result.rowsToAppend, 1);
  assert.equal(result.cellsToWrite, 3);
  assert.deepEqual(seen, ["docx.v1.documentBlock.list"]);
});

test("upsert verifies new content before deleting old managed section", async () => {
  const section = "package-all-info";
  let blocks = buildManagedBlocks(section, '{"version":1}\n').blocks;
  const calls = [];
  const mcp = {
    async call(name, args) {
      if (name === "docx.v1.documentBlockChildren.get") return { items: structuredClone(blocks) };
      if (name === "docx.v1.documentBlockChildren.create") {
        calls.push("create");
        blocks.push(...structuredClone(args.data.children));
        return { document_revision_id: 2 };
      }
      if (name === "docx.v1.documentBlockChildren.batchDelete") {
        calls.push("delete");
        blocks.splice(args.data.start_index, args.data.end_index - args.data.start_index);
        return { document_revision_id: 3 };
      }
      throw new Error(`unexpected tool: ${name}`);
    },
  };

  const content = '{\n  "version": 2\n}\n';
  const result = await writeJson(mcp, "doc-token", { content, section, heading: "PackageAllInfo", mode: "upsert" });
  assert.deepEqual(calls, ["create", "delete"]);
  assert.equal(result.status, "updated");
  assert.equal(result.verified, true);
  assert.equal(findManagedSections(blocks, section).length, 1);

  calls.length = 0;
  const retry = await writeJson(mcp, "doc-token", { content, section, heading: "PackageAllInfo", mode: "upsert" });
  assert.equal(retry.status, "unchanged");
  assert.deepEqual(calls, []);
});
