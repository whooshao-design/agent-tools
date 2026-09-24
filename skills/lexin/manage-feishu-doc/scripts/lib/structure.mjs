// 增量发布的对齐基础：本地 Markdown 切成「单元」，飞书 docs_ai XML 切成「顶层元素」，两边同粒度，
// 按顺序对齐后就知道每个单元对应哪些块 id。切分规则来自 lexin 租户实测（references/api-facts.md「块结构」）。
import { createHash } from "node:crypto";


const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

const FENCE = /^( {0,3})(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})\s+\S/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])\s+/;
const TASK_ITEM = /^ {0,3}[-*+]\s+\[[ xX]\]\s+/;
const QUOTE = /^ {0,3}>/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const IMAGE = /!\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
const XML_BLOCK = /^<([a-z][\w-]*)[\s>/]/i;
const DIAGRAM_TAGS = ["readonly-block", "whiteboard", "pre"];

const blank = (line) => line.trim() === "";
// 行内代码里的 ![x](y) 只是文字：替换成等长空格后再找图片，位置不变
const maskCode = (text) => text.replace(/(`+)[\s\S]*?\1/g, (whole) => " ".repeat(whole.length));

// 一段文字里夹着图片时，飞书会拆成「段落 / 图 / 段落」三个顶层元素
function paragraphTags(text) {
  const tags = [];
  let position = 0;
  for (const match of maskCode(text).matchAll(IMAGE)) {
    if (text.slice(position, match.index).trim()) tags.push("p");
    tags.push("img");
    position = match.index + match[0].length;
  }
  if (text.slice(position).trim() || tags.length === 0) tags.push("p");
  return tags;
}

// 列表按飞书的顶层元素切段：待办项各自一段（checkbox），其余按标记（- * + / 1. 1)）连续成段（ul/ol）。
// 缩进达到上一个顶层项正文起始列的项是嵌套项（如 `4. x` 下缩进 3 格的 `- y`），跟着上一项走
function listSegments(lines) {
  const segments = [];
  let current = null;
  let contentOffset = null;
  lines.forEach((line, index) => {
    const item = line.match(/^( *)([-*+]|\d{1,9}[.)])(\s+)/);
    const indent = item ? item[1].length : 0;
    const topLevel = item && indent <= 3 && (contentOffset === null || indent < contentOffset);
    if (!topLevel) return;
    contentOffset = indent + item[2].length + Math.min(item[3].length, 4);
    const key = TASK_ITEM.test(line) ? `checkbox:${index}` : /\d/.test(item[2]) ? `ol${item[2].slice(-1)}` : `ul${item[2]}`;
    if (!current || current.key !== key) {
      current = { key, tag: key.startsWith("checkbox") ? "checkbox" : key.slice(0, 2), start: index };
      segments.push(current);
    }
  });
  return segments.map((segment, k) => ({ ...segment, end: k + 1 < segments.length ? segments[k + 1].start : lines.length }));
}

function unitHash(kind, markdown, { diagrams, imageHashes }) {
  if (kind === "diagram") {
    return sha256(`mermaid\n${diagrams.find((item) => item.placeholder === markdown.trim())?.code ?? ""}`);
  }
  // 图片按文件内容计入，换了图但路径没变也算改动
  // 图片哈希按路径（@./相对路径）取：说明文字发布前可能被转义，路径不会
  const images = [...maskCode(markdown).matchAll(IMAGE)]
    .map((match) => imageHashes[match[1].replace(/^<(.*)>$/, "$1")] ?? "")
    .join("|");
  return sha256(`${kind}\n${markdown}\n${images}`);
}

// body 是 preparePublishMarkdown 处理过的正文（提示块已是 <callout>，mermaid 已是占位段落）
// 只有这一次生成的占位（diagrams[].placeholder）才是图；正文里形如占位的文字按普通段落处理
export function splitUnits(body, { diagrams = [], imageHashes = {} } = {}) {
  const placeholders = new Set(diagrams.map((diagram) => diagram.placeholder));
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const units = [];
  const push = (kind, start, end, tags, extra = {}) => {
    const markdown = lines.slice(start, end).join("\n").trim();
    units.push({ kind, markdown, tags, hash: unitHash(kind, markdown, { diagrams, imageHashes }), ...extra });
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i += 1;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      let j = i + 1;
      const close = new RegExp(`^ {0,3}${fence[2][0]}{${fence[2].length},}\\s*$`);
      while (j < lines.length && !close.test(lines[j])) j += 1;
      push("code", i, Math.min(j + 1, lines.length), ["pre"]);
      i = j + 1;
      continue;
    }
    if (ATX.test(line)) {
      const level = line.trim().match(/^#+/)[0].length;
      push("heading", i, i + 1, [`h${level}`], { level, inplace: true });
      i += 1;
      continue;
    }
    if (placeholders.has(line.trim())) {
      push("diagram", i, i + 1, [DIAGRAM_TAGS]);
      i += 1;
      continue;
    }
    const xml = line.trim().match(XML_BLOCK);
    if (xml && !/^br$/i.test(xml[1])) {
      let j = i + 1;
      while (j < lines.length && !blank(lines[j])) j += 1;
      push(xml[1].toLowerCase() === "callout" ? "callout" : "xml", i, j, [xml[1].toLowerCase()]);
      i = j;
      continue;
    }
    if (HR.test(line)) {
      push("hr", i, i + 1, ["hr"]);
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      let j = i + 1;
      while (j < lines.length && QUOTE.test(lines[j])) j += 1;
      push("quote", i, j, ["blockquote"]);
      i = j;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      let j = i + 1;
      while (j < lines.length) {
        const current = lines[j];
        if (blank(current)) {
          // 空行之后仍是缩进内容或同一列表的项，就还属于这个列表（松散列表）
          let k = j + 1;
          while (k < lines.length && blank(lines[k])) k += 1;
          if (k < lines.length && (/^\s{2,}\S/.test(lines[k]) || LIST_ITEM.test(lines[k]))) {
            j = k;
            continue;
          }
          break;
        }
        if (/^\s{2,}\S/.test(current) || LIST_ITEM.test(current)) {
          j += 1;
          continue;
        }
        // 紧跟在项后面、没有缩进的普通文字是懒惰续行，仍属于上一项
        if (!ATX.test(current) && !FENCE.test(current) && !QUOTE.test(current) && !HR.test(current) && !XML_BLOCK.test(current.trim())) {
          j += 1;
          continue;
        }
        break;
      }
      for (const segment of listSegments(lines.slice(i, j))) push("list", i + segment.start, i + segment.end, [segment.tag]);
      i = j;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && TABLE_SEPARATOR.test(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && !blank(lines[j]) && lines[j].includes("|")) j += 1;
      push("table", i, j, ["table"]);
      i = j;
      continue;
    }
    // 段落：直到空行或能打断段落的块；下一行是 === / --- 时是 Setext 标题
    let j = i + 1;
    while (j < lines.length && !blank(lines[j])) {
      const next = lines[j];
      if (SETEXT.test(next)) break;
      if (ATX.test(next) || FENCE.test(next) || QUOTE.test(next) || HR.test(next) || placeholders.has(next.trim())) break;
      if (/^ {0,3}[-*+]\s+\S/.test(next) || /^ {0,3}1[.)]\s+\S/.test(next)) break;
      j += 1;
    }
    if (j < lines.length && SETEXT.test(lines[j]) && !blank(lines[j])) {
      const level = lines[j].trim().startsWith("=") ? 1 : 2;
      push("heading", i, j + 1, [`h${level}`], { level, inplace: false });
      i = j + 1;
      continue;
    }
    const text = lines.slice(i, j).join("\n");
    const tags = paragraphTags(text);
    push("paragraph", i, j, tags, { inplace: tags.length === 1 && tags[0] === "p" && !/<br\s*\/?>/i.test(text) });
    i = j;
  }
  return units;
}

// ---- 飞书 docs_ai XML（--detail with-ids）→ 顶层元素 ----

const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>/g;

function attribute(attrs, name) {
  return attrs.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
}

export function normalizeElement(xml) {
  return xml.replace(/\s+id="[^"]*"/g, "");
}

const plainText = (xml) => xml.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();

export function parseTopLevel(xml) {
  const elements = [];
  let depth = 0;
  let current = null;
  for (const match of String(xml).matchAll(TAG)) {
    const [whole, closing, rawName, attrs, selfClosing] = match;
    const name = rawName.toLowerCase();
    if (name === "br") continue;
    if (!closing) {
      const id = attribute(attrs, "id");
      if (depth === 0) {
        current = { tag: name, start: match.index, id, childIds: [], allIds: id ? [id] : [], innerTags: new Set(), items: [], item: null };
      } else if (current) {
        current.innerTags.add(name);
        if (id) current.allIds.push(id);
        if (depth === 1 && name === "li" && id) {
          current.childIds.push(id);
          current.item = { id, start: match.index, allIds: [id], innerTags: new Set() };
          current.items.push(current.item);
        } else if (depth >= 2 && current.item) {
          current.item.innerTags.add(name);
          if (id) current.item.allIds.push(id);
        }
      }
      if (selfClosing) {
        if (depth === 0) {
          current.end = match.index + whole.length;
          elements.push(current);
          current = null;
        }
      } else {
        depth += 1;
      }
    } else {
      depth -= 1;
      if (depth === 1 && name === "li" && current?.item) {
        current.item.end = match.index + whole.length;
        current.item = null;
      }
      if (depth === 0 && current) {
        current.end = match.index + whole.length;
        elements.push(current);
        current = null;
      }
    }
  }
  return elements
    .filter((element) => element.tag !== "title")
    .map((element) => {
      const body = xml.slice(element.start, element.end);
      const isList = ["ul", "ol"].includes(element.tag);
      const topIds = isList ? element.childIds : element.id ? [element.id] : [];
      const text = plainText(body);
      // 顶层块：列表的每一项各是一个顶层块，其余元素自身是一个
      const blocks = isList
        ? element.items.map((item) => ({ id: item.id, tag: "li", allIds: item.allIds, innerTags: [...item.innerTags], text: plainText(xml.slice(item.start, item.end)) }))
        : topIds.map((id) => ({ id, tag: element.tag, allIds: element.allIds, innerTags: [...element.innerTags], text }));
      return {
        tag: element.tag,
        topIds,
        allIds: element.allIds,
        innerTags: [...element.innerTags],
        blocks,
        hash: sha256(normalizeElement(body)),
        text,
      };
    });
}

const tagMatches = (expected, actual) => (Array.isArray(expected) ? expected.includes(actual) : expected === actual);

// 按顺序把单元的期望标签与顶层元素一一对上；数量或类型对不上就放弃增量映射
export function alignUnits(units, elements) {
  const expected = units.flatMap((unit, index) => unit.tags.map((tag) => ({ index, tag })));
  if (expected.length !== elements.length) {
    return { ok: false, reason: `本地切出 ${expected.length} 个顶层元素，飞书上有 ${elements.length} 个` };
  }
  for (let k = 0; k < expected.length; k += 1) {
    if (!tagMatches(expected[k].tag, elements[k].tag)) {
      const want = Array.isArray(expected[k].tag) ? expected[k].tag.join("|") : expected[k].tag;
      return { ok: false, reason: `第 ${k + 1} 个顶层元素应为 ${want}，飞书上是 ${elements[k].tag}` };
    }
  }
  const mapped = units.map((unit) => ({ ...unit, blockIds: [], allIds: [], feishuHashes: [] }));
  expected.forEach(({ index }, k) => {
    mapped[index].blockIds.push(...elements[k].topIds);
    mapped[index].allIds.push(...elements[k].allIds);
    mapped[index].feishuHashes.push(elements[k].hash);
  });
  return {
    ok: true,
    units: mapped.map(({ markdown, feishuHashes, ...unit }) => ({ ...unit, feishuHash: sha256(feishuHashes.join("|")) })),
  };
}

// 顶层块在飞书上的先后位置：列表每一项各占一个位置（同一列表的项不共用位置）
export function blockOrder(elements) {
  const position = new Map();
  elements.flatMap((element) => element.blocks).forEach((block, index) => position.set(block.id, index));
  return position;
}

// 正文的块与内容快照（参数是 parseTopLevel 的结果，小组件的哈希可先并入源码）：docs_ai 没有乐观锁，
// 写之前再读一次比对，读到快照之后有人改过就不写。含全部子块 id：子块被人按原文重建（评论可能挂在新块上）也算改动
export function documentShape(elements) {
  return elements.map((element) => `${element.allIds.join(",")}:${element.hash}`).join("|");
}

// 飞书上被人改过的单元：块不见了，或块所在顶层元素的内容哈希变了；另外报告不属于任何单元的新块，
// 以及保留下来的块先后顺序变了（有人在飞书上拖动过段落，按位置重新对齐会错位）
export function remoteChanges(units, elements) {
  const byTopId = new Map();
  elements.forEach((element) => element.topIds.forEach((id) => byTopId.set(id, element)));
  const changed = [];
  const known = new Set();
  units.forEach((unit, index) => {
    const current = [];
    let missing = false;
    for (const id of unit.blockIds) {
      known.add(id);
      const element = byTopId.get(id);
      if (!element) missing = true;
      else if (!current.includes(element)) current.push(element);
    }
    const hash = sha256(current.map((element) => element.hash).join("|"));
    if (missing || hash !== unit.feishuHash) changed.push(index);
  });
  // 按顶层块找本地没有的块：原有列表里新加的一项也算
  const inserted = elements.flatMap((element) => element.blocks).filter((block) => !known.has(block.id));
  // 按旧的块序列逐块核对当前位置是否递增：同一列表内部换了顺序也算
  const position = blockOrder(elements);
  const found = units.flatMap((unit) => unit.blockIds).map((id) => position.get(id)).filter((value) => value !== undefined);
  const reordered = found.some((value, index) => index > 0 && value < found[index - 1]);
  return { changed, inserted, reordered };
}

// 按单元哈希做 LCS，返回没对上的「间隙」：旧单元区间、新单元区间、插入锚点（前一个保留单元的最后一块）
export function diffUnits(oldUnits, newUnits) {
  const n = oldUnits.length;
  const m = newUnits.length;
  const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let a = n - 1; a >= 0; a -= 1) {
    for (let b = m - 1; b >= 0; b -= 1) {
      table[a][b] = oldUnits[a].hash === newUnits[b].hash ? table[a + 1][b + 1] + 1 : Math.max(table[a + 1][b], table[a][b + 1]);
    }
  }
  const gaps = [];
  let a = 0;
  let b = 0;
  let anchor = null;
  let gap = null;
  const flush = () => {
    if (gap && (gap.oldEnd > gap.oldStart || gap.newEnd > gap.newStart)) gaps.push(gap);
    gap = null;
  };
  while (a < n || b < m) {
    if (a < n && b < m && oldUnits[a].hash === newUnits[b].hash) {
      flush();
      anchor = oldUnits[a].blockIds.at(-1) ?? anchor;
      a += 1;
      b += 1;
      continue;
    }
    if (!gap) gap = { oldStart: a, oldEnd: a, newStart: b, newEnd: b, anchor };
    if (b < m && (a >= n || table[a][b + 1] >= table[a + 1][b])) {
      b += 1;
      gap.newEnd = b;
    } else {
      a += 1;
      gap.oldEnd = a;
    }
  }
  flush();
  return gaps;
}
