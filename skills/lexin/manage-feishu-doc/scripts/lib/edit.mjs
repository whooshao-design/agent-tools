// 局部修改：按块 id 或标题定位，在文档里插入、替换、删除一段内容，或全文替换一段文字。
// 用于以飞书为准的文档和别人的文档；本地发布的文档（以本地为准）应改本地 md 后 publish。
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { preparePublishMarkdown } from "./markdown.mjs";
import { fetchContent, listOpenComments, replaceBlocks, replaceDiagramPlaceholders } from "./publish.mjs";
import { parseTopLevel } from "./structure.mjs";

// 这些块读出来无法用 Markdown 原样写回，替换或删除前要用户确认
const PROTECTED_TAGS = new Set([
  "img", "whiteboard", "readonly-block", "sheet", "bitable", "source", "figure", "synced_source",
  "synced_reference", "task", "okr", "chat_card", "iframe",
]);
const HEADING = /^h([1-9])$/;
const OPS = new Set(["insert-after", "replace", "replace-section", "delete", "delete-section", "replace-text"]);

function fail(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = { failureClass: code, missingScopes: [], ...details };
  throw error;
}

export function findHeading(elements, query) {
  const value = String(query).trim();
  const byId = elements.findIndex((element) => HEADING.test(element.tag) && element.topIds[0] === value);
  if (byId >= 0) return byId;
  const matches = elements.flatMap((element, index) => (HEADING.test(element.tag) && element.text === value ? [index] : []));
  if (matches.length === 0) fail(`找不到标题「${value}」`, "HEADING_NOT_FOUND");
  if (matches.length > 1) {
    fail(`标题「${value}」出现 ${matches.length} 次，请改用块 id：${matches.map((index) => elements[index].topIds[0]).join(", ")}`, "AMBIGUOUS_HEADING");
  }
  return matches[0];
}

// 一节 = 标题之后、下一个同级或更高级标题之前的所有顶层元素
export function sectionRange(elements, headingIndex) {
  const level = Number(elements[headingIndex].tag.match(HEADING)[1]);
  let end = headingIndex + 1;
  while (end < elements.length) {
    const next = elements[end].tag.match(HEADING);
    if (next && Number(next[1]) <= level) break;
    end += 1;
  }
  return { start: headingIndex + 1, end };
}

// 顶层块序列：列表的每一项各是一个顶层块（可单独替换、删除），其余元素各是一个
function topBlocks(elements) {
  return elements.flatMap((element, index) => element.blocks.map((block) => ({ ...block, element: index })));
}

function findBlock(blocks, id) {
  const index = blocks.findIndex((block) => block.id === id);
  if (index < 0) fail(`块 ${id} 不是文档的顶层块（先用 read --format=xml --with-ids 找顶层块 id）`, "BLOCK_NOT_FOUND");
  return index;
}

// 第 elementIndex 个顶层元素的第一个顶层块在序列里的位置；越界时是序列末尾
const firstBlockOf = (blocks, elementIndex) => {
  const index = blocks.findIndex((block) => block.element >= elementIndex);
  return index < 0 ? blocks.length : index;
};

// 把参数解析成「要移除的顶层块区间 [start, end)」和「插入锚点」
export function resolveTarget(elements, options) {
  const { op } = options;
  const blocks = topBlocks(elements);
  if (op === "insert-after") {
    if (options.at === "start") return { blocks, anchor: "0", removed: null };
    if (options.at === "end") return { blocks, anchor: "-1", removed: null };
    if (options.after) {
      findBlock(blocks, options.after);
      return { blocks, anchor: options.after, removed: null };
    }
    if (options["after-heading"]) {
      const heading = findHeading(elements, options["after-heading"]);
      const { end } = sectionRange(elements, heading);
      return { blocks, anchor: blocks[firstBlockOf(blocks, end) - 1].id, removed: null, heading: elements[heading].text };
    }
    fail("insert-after 需要 --after=<块 id>、--after-heading=<标题> 或 --at=start|end", "INVALID_ARGUMENT");
  }
  if (op === "replace" || op === "delete") {
    if (!options.block) fail(`${op} 需要 --block=<块 id>，范围再加 --end-block=<块 id>`, "INVALID_ARGUMENT");
    const start = findBlock(blocks, options.block);
    const end = options["end-block"] ? findBlock(blocks, options["end-block"]) + 1 : start + 1;
    if (end <= start) fail("--end-block 必须在 --block 之后", "INVALID_ARGUMENT");
    return { blocks, anchor: null, removed: { start, end } };
  }
  if (op === "replace-section" || op === "delete-section") {
    if (!options.heading) fail(`${op} 需要 --heading=<标题文字或块 id>`, "INVALID_ARGUMENT");
    const heading = findHeading(elements, options.heading);
    const section = sectionRange(elements, heading);
    const start = firstBlockOf(blocks, options["include-heading"] ? heading : section.start);
    const end = firstBlockOf(blocks, section.end);
    if (end <= start) {
      if (op === "delete-section") fail("这一节没有内容可删（要连标题一起删请加 --include-heading）", "EMPTY_SECTION");
      return { blocks, anchor: elements[heading].topIds[0], removed: null, heading: elements[heading].text };
    }
    return { blocks, anchor: null, removed: { start, end }, heading: elements[heading].text };
  }
  fail(`不支持的 --op=${op}；可用：${[...OPS].join("、")}`, "INVALID_ARGUMENT");
}

function countOccurrences(text, pattern) {
  let count = 0;
  for (let index = text.indexOf(pattern); index >= 0; index = text.indexOf(pattern, index + pattern.length)) count += 1;
  return count;
}

function loadFragment(file) {
  const path = resolve(file);
  if (!existsSync(path)) fail(`找不到文件 ${path}`, "FILE_NOT_FOUND");
  const prepared = preparePublishMarkdown(readFileSync(path, "utf8"), {
    fileName: basename(path),
    baseDir: dirname(path),
    exists: existsSync,
    extractTitle: false,
  });
  if (prepared.errors.length > 0) fail(`片段检查未通过：${prepared.errors.join("；")}`, "PUBLISH_PRECHECK_FAILED", { errors: prepared.errors });
  if (!prepared.body.trim()) fail(`片段 ${path} 是空的；要删除请用 --op=delete 或 delete-section`, "EMPTY_FRAGMENT");
  return { ...prepared, baseDir: dirname(path) };
}

export async function editDocument(transport, documentToken, options) {
  const op = options.op;
  if (!OPS.has(op)) fail(`不支持的 --op=${op ?? ""}；可用：${[...OPS].join("、")}`, "INVALID_ARGUMENT");

  if (op === "replace-text") {
    if (typeof options.pattern !== "string" || !options.pattern || typeof options.content !== "string") {
      fail("replace-text 需要 --pattern=<原文> 和 --content=<新文字>（--content= 留空表示删掉原文）", "INVALID_ARGUMENT");
    }
    if (options.pattern.includes("\n")) fail("--pattern 只能是单行行内文字；整段或多行请用 replace / replace-section", "INVALID_ARGUMENT");
    // markdown 模式下服务端按导出的 Markdown（特殊字符已转义）匹配、且替换全部匹配处，计数也用这份
    const { content: markdown } = await fetchContent(transport, documentToken, "markdown");
    const count = countOccurrences(markdown, options.pattern);
    if (count === 0) fail(`找不到「${options.pattern}」（按 read --format=markdown 的写法匹配，特殊字符带反斜杠转义）`, "PATTERN_NOT_FOUND");
    if (count > 1 && !options.all) fail(`「${options.pattern}」出现 ${count} 次，全部替换请加 --all，否则改用更长、唯一的片段`, "AMBIGUOUS_PATTERN");
    if (options.dryRun) return { status: "dry_run", op, occurrences: count };
    // 新文字走 stdin：以 @ 开头的参数会被 lark-cli 当成文件路径
    const data = await transport.shortcut(
      ["docs", "+update", "--doc", documentToken, "--command", "str_replace", "--doc-format", "markdown", `--pattern=${options.pattern}`, "--content", "-"],
      { input: options.content },
    );
    const warnings = data.warnings ?? [];
    return { status: data.result === "success" && warnings.length === 0 ? "updated" : "updated_with_issues", op, occurrences: count, result: data.result, warnings };
  }

  const { content: xml } = await fetchContent(transport, documentToken, "xml", "with-ids");
  const elements = parseTopLevel(xml);

  const target = resolveTarget(elements, options);
  const needsContent = !op.startsWith("delete");
  const fragment = needsContent ? loadFragment(options.file ?? fail(`${op} 需要 --file=<Markdown 片段>`, "INVALID_ARGUMENT")) : null;
  const removed = target.removed ? target.blocks.slice(target.removed.start, target.removed.end) : [];
  const blockers = [];
  const protectedTags = [...new Set(removed.flatMap((block) => [block.tag, ...block.innerTags]).filter((tag) => PROTECTED_TAGS.has(tag)))];
  if (protectedTags.length > 0 && !options.allowProtected) {
    blockers.push({ check: "protected_blocks", message: `范围里有 ${protectedTags.join("、")}，读出后无法用 Markdown 原样写回：确认要替换或删除再加 --allow-protected`, tags: protectedTags });
  }
  const removedIds = new Set(removed.flatMap((block) => block.allIds));
  const comments = removed.length ? (await listOpenComments(transport, documentToken)).filter((comment) => removedIds.has(comment.anchor)) : [];
  if (comments.length > 0 && !options.acceptCommentLoss) {
    blockers.push({ check: "open_comments", message: `有 ${comments.length} 条未解决评论挂在要替换或删除的块上：先处理，或确认后加 --accept-comment-loss`, comments: comments.slice(0, 10) });
  }
  const preview = {
    op,
    heading: target.heading ?? null,
    anchor: target.anchor,
    removedBlocks: removed.length,
    removedPreview: removed.slice(0, 8).map((block) => `${block.tag}: ${block.tag === "readonly-block" ? "（小组件，如文本绘图）" : block.text.slice(0, 60)}`),
    insertExpected: fragment?.expected ?? null,
    localWarnings: fragment?.warnings ?? [],
  };
  if (blockers.length > 0 || options.dryRun) return { status: blockers.length > 0 ? "blocked" : "dry_run", ...preview, blockers };

  const results = await replaceBlocks(transport, documentToken, {
    ids: removed.map((block) => block.id),
    readonly: new Set(removed.filter((block) => block.tag === "readonly-block").map((block) => block.id)),
    anchor: removed.length ? (target.blocks[target.removed.start - 1]?.id ?? "0") : target.anchor,
    markdown: fragment?.body,
    cwd: fragment?.baseDir,
  });
  const warnings = results.flatMap((data) => data.warnings ?? []);
  const diagrams = fragment ? await replaceDiagramPlaceholders(transport, documentToken, fragment.diagrams) : [];
  const after = await fetchContent(transport, documentToken, "xml", "with-ids");
  const leftovers = (after.content.match(/\[\[feishu-mermaid:\d+\]\]/g) ?? []).length;
  const problems = results.some((data) => data.result !== "success") || warnings.length > 0 || leftovers > 0 || diagrams.some((item) => item.status !== "widget");
  return {
    status: problems ? "updated_with_issues" : "updated",
    ...preview,
    results: results.map((data) => data.result),
    warnings,
    diagrams,
    revision: after.revision,
  };
}
