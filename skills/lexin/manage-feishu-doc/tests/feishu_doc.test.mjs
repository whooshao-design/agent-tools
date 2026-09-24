import assert from "node:assert/strict";
import test from "node:test";

import {
  assessAuthorization,
  buildHeadingLinkPlan,
  elementsSignature,
  encodeLinkUrl,
  prepareTextPlan,
  updateTextElements,
  buildManagedBlocks,
  cellBlockTarget,
  checkAuthorization,
  classifyFailure,
  deterministicClientToken,
  diffTable,
  findManagedSections,
  listTables,
  parseAuthStatus,
  parseTarget,
  readDocument,
  readTable,
  requiredScopes,
  syncTable,
  writeJson,
} from "../scripts/feishu_doc.mjs";
import { LarkCliError } from "../scripts/lib/transport.mjs";

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

test("parseAuthStatus reads lark-cli status without tokens and tracks refresh expiry", () => {
  const now = Date.parse("2026-09-23T10:00:00+08:00");
  const status = {
    identities: {
      user: {
        status: "ready",
        tokenStatus: "valid",
        scope: "docx:document offline_access",
        expiresAt: "2026-09-23T12:00:00+08:00",
        refreshExpiresAt: "2026-09-30T10:00:00+08:00",
      },
    },
  };
  const session = parseAuthStatus(status, now);
  assert.equal(session.active, true);
  assert.equal(session.expired, false);
  assert.deepEqual(session.scopes, ["docx:document", "offline_access"]);
  assert.equal(session.hasRefreshToken, true);
  assert.equal(parseAuthStatus({ identities: { user: { status: "missing" } } }, now).active, false);

  // lark-cli 1.0.96：访问令牌过期、刷新令牌有效时报 needs_refresh，下一次调用会自动续期
  const stale = parseAuthStatus({ identities: { user: { ...status.identities.user, status: "needs_refresh", tokenStatus: "needs_refresh", scope: requiredScopes("read").join(" ") } } }, now);
  assert.deepEqual([stale.active, stale.expired, stale.hasRefreshToken], [true, true, true]);
  assert.equal(assessAuthorization(stale, "read").ready, true);
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

test("checkAuthorization trusts lark-cli refresh and warns before the refresh token runs out", async () => {
  const scopes = ["docx:document:readonly", "offline_access"];
  const soon = Math.floor(Date.now() / 1000) + 3600;
  const later = Math.floor(Date.now() / 1000) + 5 * 24 * 3600;
  const expired = { active: true, expired: true, hasRefreshToken: true, scopes, refreshExpiresAt: later };
  const usable = await checkAuthorization("read", { kind: "docx" }, { status: () => expired });
  assert.equal(usable.result.ready, true);
  assert.equal(usable.result.warning, undefined);

  const dead = await checkAuthorization("read", { kind: "docx" }, { status: () => ({ ...expired, hasRefreshToken: false }) });
  assert.equal(dead.result.failureClass, "TOKEN_EXPIRED");

  const expiring = await checkAuthorization("read", { kind: "docx" }, {
    status: () => ({ active: true, expired: false, hasRefreshToken: true, scopes, refreshExpiresAt: soon }),
  });
  assert.match(expiring.result.warning, /24 小时/);
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

test("classifyFailure distinguishes app publication and ACL, and trusts lark-cli classification", () => {
  assert.equal(classifyFailure("OAuth error 20027").failureClass, "APP_PERMISSION_NOT_PUBLISHED");
  assert.equal(classifyFailure("403 forbidden: no permission").failureClass, "DOCUMENT_ACCESS_DENIED");
  const error = new LarkCliError("missing", {
    ok: false,
    error: { type: "authorization", subtype: "missing_scope", code: 99991679, missing_scopes: ["board:whiteboard:node:create"] },
  });
  assert.equal(classifyFailure(error).failureClass, "OAUTH_SCOPE_MISSING");
  assert.deepEqual(classifyFailure(error).missingScopes, ["board:whiteboard:node:create"]);
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

test("syncTable can append rows again in a later run: Feishu drops requests that reuse a client_token", async () => {
  const blocks = buildTableDoc([["ID", "名称"], ["M1000", "调用数"]], { fillerParagraph: false });
  const seen = new Set();
  const mcp = {
    async call(name, args) {
      if (name === "docx.v1.documentBlock.list") return { items: structuredClone(blocks) };
      const token = args.params?.client_token;
      if (token && seen.has(token)) return {};
      if (token) seen.add(token);
      if (name === "docx.v1.documentBlock.patch") {
        const table = blocks.find((item) => item.block_id === "table-1");
        const rowIndex = table.table.property.row_size;
        for (let column = 0; column < table.table.property.column_size; column += 1) {
          const cellId = `cell-${rowIndex}-${column}`;
          blocks.push({ block_id: `text-${rowIndex}-${column}`, block_type: 2, parent_id: cellId, text: { elements: [{ text_run: { content: "" } }] } });
          blocks.push({ block_id: cellId, block_type: 32, parent_id: "table-1", children: [`text-${rowIndex}-${column}`] });
          table.table.cells.push(cellId);
        }
        table.table.property.row_size += 1;
        return {};
      }
      if (name === "docx.v1.documentBlock.batchUpdate") {
        for (const request of args.data.requests) {
          blocks.find((item) => item.block_id === request.block_id).text.elements = request.update_text_elements.elements;
        }
        return {};
      }
      throw new Error(`unexpected tool: ${name}`);
    },
  };
  const first = [["ID", "名称"], ["M1000", "调用数"], ["M1001", "通过数"]];
  assert.equal((await syncTable(mcp, "doc-token", { tableId: "table-1", rows: first })).status, "updated");
  const second = [...first, ["M1002", "拒绝数"]];
  const result = await syncTable(mcp, "doc-token", { tableId: "table-1", rows: second });
  assert.equal(result.status, "updated");
  assert.deepEqual(readTable(blocks, "table-1").rows, second);
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

const DOC = "DocToken123";
function textBlock(id, type, runs) {
  const key = { 2: "text", 4: "heading2", 6: "heading4", 12: "bullet", 14: "code" }[type];
  return {
    block_id: id,
    block_type: type,
    [key]: {
      elements: runs.map(([content, style = {}]) => ({
        text_run: { content, text_element_style: { bold: false, inline_code: false, italic: false, strikethrough: false, underline: false, ...style } },
      })),
    },
  };
}

test("encodeLinkUrl encodes raw URLs once and keeps encoded ones", () => {
  const raw = `https://lexin.feishu.cn/docx/${DOC}#doxcnA`;
  const encoded = encodeLinkUrl(raw);
  assert.equal(encoded, encodeURIComponent(raw));
  assert.equal(encodeLinkUrl(encoded), encoded);
});

test("prepareTextPlan validates items and encodes link urls", () => {
  const plan = prepareTextPlan({
    updates: [
      { block_id: "b1", elements: [{ text_run: { content: "x", text_element_style: { link: { url: "https://a.b/c#d" } } } }], text: "extra" },
    ],
  });
  assert.deepEqual(Object.keys(plan[0]), ["block_id", "elements"]);
  assert.equal(plan[0].elements[0].text_run.text_element_style.link.url, encodeURIComponent("https://a.b/c#d"));
  assert.throws(() => prepareTextPlan([]), (error) => error.code === "INVALID_PLAN");
  assert.throws(
    () => prepareTextPlan([{ block_id: "b", elements: [{}] }, { block_id: "b", elements: [{}] }]),
    (error) => error.code === "INVALID_PLAN",
  );
  assert.throws(() => prepareTextPlan([{ block_id: "b", elements: [] }]), (error) => error.code === "INVALID_PLAN");
});

test("elementsSignature merges same-style runs and compares decoded links", () => {
  const url = "https://lexin.feishu.cn/docx/x#y";
  const a = [
    { text_run: { content: "见", text_element_style: {} } },
    { text_run: { content: "下文", text_element_style: { bold: false } } },
    { text_run: { content: "第 3 章", text_element_style: { link: { url: encodeURIComponent(url) } } } },
  ];
  const b = [
    { text_run: { content: "见下文" } },
    { text_run: { content: "第 3 章", text_element_style: { link: { url } } } },
  ];
  assert.deepEqual(elementsSignature(a), elementsSignature(b));
  assert.equal(elementsSignature(a)[1].style.link, url);
  const c = [{ text_run: { content: "见下文第 3 章", text_element_style: {} } }];
  assert.notDeepEqual(elementsSignature(a), elementsSignature(c));
});

test("buildHeadingLinkPlan splits runs, keeps style, and skips headings, code, links and inline code", () => {
  const blocks = [
    textBlock("h3", 4, [["3. 查询方法"]]),
    textBlock("h4", 6, [["3.1 实例"]]),
    textBlock("p1", 2, [["详见第 3 章和 3.1 实例。", { bold: true }]]),
    textBlock("p2", 2, [["第 3 章", { inline_code: true }], ["已链接", { link: { url: "x" } }]]),
    textBlock("p3", 12, [["无关文本"]]),
    textBlock("c1", 14, [["第 3 章"]]),
  ];
  const { plan, linkCount, targets } = buildHeadingLinkPlan(blocks, DOC, { "第 3 章": "3. 查询方法", "3.1 实例": "h4" });
  assert.deepEqual(targets, { "第 3 章": "h3", "3.1 实例": "h4" });
  assert.equal(linkCount, 2);
  assert.deepEqual(plan.map((item) => item.block_id), ["p1"]);
  const runs = plan[0].elements.map((element) => element.text_run);
  assert.deepEqual(runs.map((run) => run.content), ["详见", "第 3 章", "和 ", "3.1 实例", "。"]);
  assert.ok(runs.every((run) => run.text_element_style.bold === true), "原 run 的加粗要沿用");
  assert.equal(runs[1].text_element_style.link.url, encodeURIComponent(`https://lexin.feishu.cn/docx/${DOC}#h3`));
  assert.equal(runs[0].text_element_style.link, undefined);

  // Rerunning on the linked output is a no-op.
  const after = blocks.map((block) => (block.block_id === "p1" ? { ...block, text: { elements: plan[0].elements } } : block));
  assert.equal(buildHeadingLinkPlan(after, DOC, { "第 3 章": "3. 查询方法" }).plan.length, 0);

  // Wiki-hosted documents link through the wiki page so the jump scrolls in place instead of opening a new page.
  const wiki = buildHeadingLinkPlan(blocks, DOC, { "第 3 章": "3. 查询方法" }, { wikiToken: "WIKI123" });
  assert.equal(wiki.plan[0].elements[1].text_run.text_element_style.link.url, encodeURIComponent("https://lexin.feishu.cn/wiki/WIKI123#h3"));

  assert.throws(() => buildHeadingLinkPlan(blocks, DOC, { x: "不存在" }), (error) => error.code === "HEADING_NOT_FOUND");
  const dup = [...blocks, textBlock("h3b", 4, [["3. 查询方法"]])];
  assert.throws(() => buildHeadingLinkPlan(dup, DOC, { x: "3. 查询方法" }), (error) => error.code === "AMBIGUOUS_HEADING");
});

test("updateTextElements batches, skips unchanged blocks, and verifies readback", async () => {
  const blocks = Array.from({ length: 45 }, (_, index) => textBlock(`b${index}`, 2, [[`old ${index}`]]));
  blocks.push(textBlock("same", 2, [["keep"]]));
  const calls = [];
  const mcp = {
    async call(name, args) {
      if (name === "docx.v1.documentBlock.list") return { items: structuredClone(blocks) };
      if (name === "docx.v1.documentBlock.batchUpdate") {
        calls.push({ size: args.data.requests.length, token: args.params.client_token });
        for (const request of args.data.requests) {
          blocks.find((block) => block.block_id === request.block_id).text.elements = request.update_text_elements.elements;
        }
        return { document_revision_id: 7 };
      }
      throw new Error(`unexpected tool: ${name}`);
    },
  };
  const plan = prepareTextPlan([
    ...Array.from({ length: 45 }, (_, index) => ({
      block_id: `b${index}`,
      elements: [{ text_run: { content: `new ${index}`, text_element_style: { link: { url: "https://x.y/z" } } } }],
    })),
    { block_id: "same", elements: [{ text_run: { content: "keep" } }] },
  ]);

  const dry = await updateTextElements(mcp, DOC, plan, { dryRun: true });
  assert.equal(dry.status, "dry_run");
  assert.equal(dry.toWrite, 45);
  assert.equal(dry.preview[0].before, "old 0");
  assert.deepEqual(dry.preview[0].links, ["https://x.y/z"]);
  assert.equal(calls.length, 0);

  const result = await updateTextElements(mcp, DOC, plan);
  assert.equal(result.status, "updated");
  assert.equal(result.blocksWritten, 45);
  assert.deepEqual(calls.map((call) => call.size), [40, 5]);
  assert.notEqual(calls[0].token, calls[1].token);

  calls.length = 0;
  assert.equal((await updateTextElements(mcp, DOC, plan)).status, "unchanged");
  assert.equal(calls.length, 0);

  await assert.rejects(
    () => updateTextElements(mcp, DOC, prepareTextPlan([{ block_id: "missing", elements: [{ text_run: { content: "x" } }] }])),
    (error) => error.code === "BLOCK_NOT_FOUND",
  );
});

test("updateTextElements reports VERIFY_FAILED when readback differs", async () => {
  const blocks = [textBlock("b1", 2, [["old"]])];
  const mcp = {
    async call(name) {
      if (name === "docx.v1.documentBlock.list") return { items: structuredClone(blocks) };
      return { document_revision_id: 1 }; // write silently ignored
    },
  };
  await assert.rejects(
    () => updateTextElements(mcp, DOC, prepareTextPlan([{ block_id: "b1", elements: [{ text_run: { content: "new" } }] }])),
    (error) => error.code === "VERIFY_FAILED" && error.details.mismatches[0].block_id === "b1",
  );
});

test("readDocument fills text-drawing widgets back in as mermaid fences and leaves other widgets alone", async () => {
  const markdown = 'A\n\n<readonly-block type="isv"></readonly-block>\n\n<readonly-block type="isv"></readonly-block>\n';
  const xml = '<p>A</p><readonly-block id="w1" type="isv"></readonly-block><readonly-block id="w2" type="isv"></readonly-block>';
  const transport = {
    async shortcut(args) {
      const format = args[args.indexOf("--doc-format") + 1];
      return { document: { content: format === "xml" ? xml : markdown, revision_id: 3 } };
    },
    async call(name, args) {
      assert.equal(name, "docx.v1.documentBlock.get");
      const record = args.path.block_id === "w1" ? JSON.stringify({ data: "flowchart LR\n  A-->B", view: "chart" }) : "{}";
      const componentType = args.path.block_id === "w1" ? "blk_631fefbbae02400430b8f9f4" : "blk_other";
      return { block: { block_id: args.path.block_id, add_ons: { component_type_id: componentType, record } } };
    },
  };
  const result = await readDocument(transport, "D1", {});
  assert.deepEqual(result.widgets, { mermaid: 1, other: 1 });
  assert.match(result.content, /```mermaid\nflowchart LR\n  A-->B\n```/);
  assert.match(result.content, /<readonly-block type="isv"><\/readonly-block>\n$/);
  const text = await readDocument({ call: async () => ({ content: "plain" }) }, "D1", { format: "text" });
  assert.equal(text.content, "plain");
});
