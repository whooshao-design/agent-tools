// 发布前把本地 Markdown 整理成 docs_ai 能正确落块的形式。规则都来自 lexin 租户实测，
// 见 references/publish.md 与 references/api-facts.md。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { MERMAID_PLACEHOLDER_PATTERN, splitUnits } from "./structure.mjs";

export { MERMAID_PLACEHOLDER_PATTERN };
export const MERMAID_PLACEHOLDER = (index) => `[[feishu-mermaid:${index}]]`;

// GitHub 提示块 → 高亮块。emoji 只用飞书表情枚举里有的（没有 ⚠️）
export const ALERT_STYLES = Object.freeze({
  NOTE: { emoji: "📝", background: "light-blue", border: "blue" },
  TIP: { emoji: "💡", background: "light-green", border: "green" },
  IMPORTANT: { emoji: "📌", background: "light-purple", border: "purple" },
  WARNING: { emoji: "❗", background: "light-orange", border: "orange" },
  CAUTION: { emoji: "⛔", background: "light-red", border: "red" },
});

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)?.*$/;
const ALERT_START = /^ {0,3}>\s?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const IMAGE = /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(\s+"[^"]*")?\)/g;
const AUTOLINK = /^<(https?:\/\/|mailto:)[^>\s]+>/i;
// 用户在 Markdown 里有意写的 DocxXML 标签照常放行（例如用 <table> 写合并单元格）；其余形如标签的一律转义
const DOCX_TAGS = new Set([
  "a", "b", "blockquote", "br", "callout", "checkbox", "cite", "code", "col", "colgroup", "column", "del", "em",
  "figure", "grid", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "latex", "li", "ol", "p", "pre", "source",
  "span", "table", "tbody", "td", "th", "thead", "time", "tr", "u", "ul",
]);

export function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text) {
  return escapeXml(text).replace(/"/g, "&quot;");
}

// 高亮块里 Markdown 行内语法不会被解析（实测），要先转成 DocxXML 行内标签
export function inlineToXml(text) {
  const codes = [];
  let value = String(text).replace(/(`+)([\s\S]*?)\1/g, (_, __, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  value = value.replace(/<br\s*\/?>/gi, "\u0001");
  const links = [];
  value = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    links.push({ label, url });
    return `\u0002${links.length - 1}\u0002`;
  });
  value = escapeXml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_]+)__/g, "<b>$1</b>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  value = value.replace(/\u0002(\d+)\u0002/g, (_, index) => {
    const { label, url } = links[Number(index)];
    return `<a href="${escapeAttribute(url)}">${inlineToXml(label)}</a>`;
  });
  return value
    .replace(/\u0001/g, "<br/>")
    .replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${escapeXml(codes[Number(index)])}</code>`);
}

// 提示块内容：段落、无序/有序列表、待办；高亮块只允许 p/ul/ol/checkbox（DocxXML 规则）
export function alertToCallout(type, lines) {
  const style = ALERT_STYLES[type.toUpperCase()];
  const parts = [];
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (paragraph.length) parts.push(`<p>${inlineToXml(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) parts.push(`<${list.tag}>${list.items.map((item) => `<li>${inlineToXml(item)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const task = line.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
    const bullet = line.match(/^[-*+]\s+(.*)$/);
    const ordered = line.match(/^\d+[.)]\s+(.*)$/);
    if (!line) {
      flushParagraph();
      flushList();
    } else if (task) {
      flushParagraph();
      flushList();
      parts.push(`<checkbox done="${task[1].trim() ? "true" : "false"}">${inlineToXml(task[2])}</checkbox>`);
    } else if (bullet || ordered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((bullet ?? ordered)[1]);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  if (parts.length === 0) parts.push("<p></p>");
  return `<callout emoji="${style.emoji}" background-color="${style.background}" border-color="${style.border}">${parts.join("")}</callout>`;
}

// 正文里形如标签的 `<` 会被当成 DocxXML 标签删掉（`List<String>` 实测只剩 `List`），代码里的不动
export function escapeTagLikeText(line) {
  return line
    .split(/(`+[^`]*`+)/g)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      let out = "";
      for (let i = 0; i < segment.length; i += 1) {
        const rest = segment.slice(i);
        if (segment[i] === "<" && segment[i - 1] !== "\\" && /^<[A-Za-z/!?]/.test(rest)) {
          const name = rest.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/)?.[1]?.toLowerCase();
          out += AUTOLINK.test(rest) || (name && DOCX_TAGS.has(name)) ? "<" : "\\<";
        } else {
          out += segment[i];
        }
      }
      return out;
    })
    .join("");
}

function splitFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { title: null, body: markdown };
  const title = match[1].match(/^title:\s*["']?(.*?)["']?\s*$/m)?.[1] ?? null;
  return { title: title || null, body: markdown.slice(match[0].length) };
}

function takeTitle(body, frontTitle, fileName) {
  const lines = body.split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  const h1 = first >= 0 ? lines[first].match(/^#\s+(.+?)\s*#*\s*$/) : null;
  if (h1 && (!frontTitle || h1[1].trim() === frontTitle.trim())) {
    lines.splice(first, 1);
    return { title: frontTitle ?? h1[1].trim(), body: lines.join("\n") };
  }
  return { title: frontTitle ?? basename(fileName ?? "untitled.md").replace(/\.(md|markdown)$/i, ""), body };
}

// 把 body 里的图片改成 lark-cli 能上传的 @./相对路径；只接受文档目录内的本地文件
function rewriteImages(line, baseDir, exists, readFile, collect) {
  return line.replace(IMAGE, (whole, alt, rawTarget, title = "") => {
    const target = rawTarget.startsWith("<") ? rawTarget.slice(1, -1) : rawTarget;
    if (/^https?:\/\//i.test(target) || target.startsWith("@")) {
      collect.images.push({ source: target, remote: /^https?:/i.test(target) });
      return whole;
    }
    if (/^data:/i.test(target)) {
      collect.errors.push(`不支持 data URI 图片（${alt || "无说明"}），先存成本地文件`);
      return whole;
    }
    let decoded;
    try {
      decoded = decodeURI(target);
    } catch {
      collect.errors.push(`图片路径无法解码：${target}`);
      return whole;
    }
    const absolute = isAbsolute(decoded) ? decoded : resolve(baseDir, decoded);
    const rel = relative(baseDir, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      collect.errors.push(`图片不在文档目录下，lark-cli 只能上传当前目录内的文件：${target}`);
      return whole;
    }
    if (!exists(absolute)) {
      collect.errors.push(`图片不存在：${target}`);
      return whole;
    }
    collect.images.push({ source: target, remote: false, path: absolute });
    const ref = `@./${rel.split("\\").join("/")}`;
    const rewritten = `![${alt}](${/\s/.test(ref) ? `<${ref}>` : ref}${title})`;
    // 增量发布按图片内容判断是否改动：路径不变但换了图也要重传
    collect.imageHashes[rewritten] = createHash("sha256").update(readFile(absolute)).digest("hex");
    return rewritten;
  });
}

export function preparePublishMarkdown(
  markdown,
  { fileName = "untitled.md", baseDir = ".", exists = () => true, readFile = readFileSync, extractTitle = true } = {},
) {
  const front = splitFrontmatter(markdown.replace(/\r\n/g, "\n"));
  // 往已有文档插入片段时不提取标题，片段开头的 # 就是正文里的一级标题
  const { title, body } = extractTitle ? takeTitle(front.body, front.title, fileName) : { title: front.title, body: front.body };
  const collect = { images: [], errors: [], warnings: [], imageHashes: {} };
  const diagrams = [];
  const expected = { headings: 0, tables: 0, images: 0, callouts: 0, diagrams: 0 };
  const out = [];
  const lines = body.split("\n");
  let fence = null;
  let inComment = false;
  let removedComments = 0;
  let anchorLinks = 0;

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];

    if (fence) {
      if (fence.mermaid) {
        if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`).test(line)) {
          const index = diagrams.length + 1;
          diagrams.push({ index, placeholder: MERMAID_PLACEHOLDER(index), code: fence.body.join("\n") });
          out.push("", MERMAID_PLACEHOLDER(index), "");
          fence = null;
        } else {
          fence.body.push(line.slice(Math.min(fence.indent, line.match(/^ */)[0].length)));
        }
        continue;
      }
      out.push(line);
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`).test(line)) fence = null;
      continue;
    }

    if (inComment) {
      const end = line.indexOf("-->");
      if (end < 0) continue;
      inComment = false;
      line = line.slice(end + 3);
      if (!line.trim()) continue;
    }

    const open = line.match(FENCE_OPEN);
    if (open) {
      const info = (open[3] ?? "").toLowerCase();
      fence = { char: open[2][0], length: open[2].length, indent: open[1].length, mermaid: info === "mermaid", body: [] };
      if (!fence.mermaid) out.push(line);
      continue;
    }

    // HTML 注释会被服务端删掉并报 warning，发布前直接去掉
    line = line.replace(/<!--[\s\S]*?-->/g, () => {
      removedComments += 1;
      return "";
    });
    const commentStart = line.indexOf("<!--");
    if (commentStart >= 0) {
      removedComments += 1;
      inComment = true;
      line = line.slice(0, commentStart);
      if (!line.trim()) continue;
    }

    const alert = line.match(ALERT_START);
    if (alert) {
      const content = alert[2] ? [alert[2]] : [];
      while (i + 1 < lines.length && /^ {0,3}>/.test(lines[i + 1])) {
        i += 1;
        content.push(lines[i].replace(/^ {0,3}>\s?/, ""));
      }
      out.push(alertToCallout(alert[1], content));
      expected.callouts += 1;
      continue;
    }

    if (/^ {0,3}#{1,6}\s+\S/.test(line)) expected.headings += 1;
    if (line.includes("|") && TABLE_SEPARATOR.test(line) && i > 0 && lines[i - 1].includes("|")) expected.tables += 1;
    if (/<callout[\s>]/.test(line)) expected.callouts += (line.match(/<callout[\s>]/g) ?? []).length;
    if (/<whiteboard[\s>]/i.test(line)) {
      collect.errors.push("Markdown 里不要写 <whiteboard>：实测会解析失败并被整块丢弃，画图改用 ```mermaid 代码块");
    }
    anchorLinks += (line.match(/\]\(#[^)]+\)/g) ?? []).length;

    line = rewriteImages(line, baseDir, exists, readFile, collect);
    out.push(/<callout[\s>]/.test(line) ? line : escapeTagLikeText(line));
  }

  if (fence) collect.errors.push(`代码块没有闭合（从 ${fence.mermaid ? "mermaid" : "代码"}块开始）`);
  expected.images = collect.images.length;
  expected.diagrams = diagrams.length;
  if (removedComments) collect.warnings.push(`去掉了 ${removedComments} 处 HTML 注释（飞书不保留注释）`);
  if (anchorLinks) collect.warnings.push(`${anchorLinks} 个页内锚点链接发布后只剩文字，后续用 link-plan 补成标题跳转`);

  const finalBody = out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  // 标题数按切分器统计，Setext 写法（下一行是 === / ---）也算
  expected.headings = splitUnits(finalBody, { diagrams }).filter((unit) => unit.kind === "heading").length;
  return {
    title,
    body: finalBody,
    diagrams,
    expected,
    images: collect.images,
    imageHashes: collect.imageHashes,
    warnings: collect.warnings,
    errors: collect.errors,
  };
}
