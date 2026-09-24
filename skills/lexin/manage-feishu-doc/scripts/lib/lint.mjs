// 写前检查：发布到飞书前找出会出错或不好读的写法。规则来自 lexin 租户实测和 references/authoring-rules.md。
// lintMarkdown 只做静态检查，返回 [{level: "error"|"warning", rule, line, message}]，line 是源文件行号；
// lintFile 另外调用 dev-design-solution 的 check_mermaid.js 做 mermaid 语法校验。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)/;
const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const ALERT = /^ {0,3}>\s?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;
const ORDERED_ITEM = /^( {0,3})(\d+)[.)]\s+\S/;
const LIST_ITEM = /^ {0,3}([-*+]|\d+[.)])\s+\S/;
// 公共渲染服务会把图的源码发到外网
const PUBLIC_RENDERERS = /https?:\/\/[^\s)"'>]*\b(mermaid\.ink|mermaid\.live|kroki\.io|plantuml\.com)\b/i;
// 不在 DocxXML 里的 HTML 标签会被转义成文字显示
const HTML_ONLY_TAG = /<\/?(div|details|summary|font|center|sup|sub|kbd|mark|small|big|iframe|video|audio|script|style|section|article|header|footer|nav|abbr|dl|dt|dd|strike|ins|q|var|samp|s)(?=[\s>/])/i;
const CHINESE_NUMBERING = /^(第[一二三四五六七八九十百零]+[章节部分篇]|[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）)/;
// 公文式「一、（一）1.（1）」是一套编号；要避免的是「一、」下面接「1.1」这种多级小数编号
const DECIMAL_NUMBERING = /^\d{1,2}\.\d{1,2}/;
const QUOTE_REQUIRED = new Set(["quadrantchart", "xychart", "xychart-beta", "sankey", "sankey-beta"]);

export const CHECK_MERMAID = fileURLToPath(new URL("../../../../dev-workflow/dev-design-solution/scripts/check_mermaid.js", import.meta.url));

// 行内代码里的内容不参与检查：替换成等长空格，列位置不变
const stripCodeSpans = (line) => line.replace(/(`+)([\s\S]*?)\1/g, (whole) => " ".repeat(whole.length));

// HTML 注释的扫描，发布预处理和写前检查共用：从左到右，行内代码原样保留（代码里的 <!-- 不算注释），
// 注释里的反引号不算代码，跨行注释接着上一行的状态。stripped 是去掉注释后的文字；touched 表示这一行有注释内容
export function scanComments(line, inComment) {
  let stripped = "";
  let removed = 0;
  let touched = inComment;
  let i = 0;
  while (i < line.length) {
    if (inComment) {
      const end = line.indexOf("-->", i);
      i = end < 0 ? line.length : end + 3;
      if (end >= 0) inComment = false;
    } else if (line[i] === "`") {
      const run = line.slice(i).match(/^`+/)[0];
      const close = line.indexOf(run, i + run.length);
      const stop = close < 0 ? i + run.length : close + run.length;
      stripped += line.slice(i, stop);
      i = stop;
    } else if (line.startsWith("<!--", i)) {
      removed += 1;
      touched = true;
      inComment = true;
      i += 4;
    } else {
      stripped += line[i];
      i += 1;
    }
  }
  return { stripped, inComment, removed, touched };
}

function sentenceCount(text) {
  return text.split(/[。！？!?]|\.(?=\s|$)/).filter((part) => part.trim()).length;
}

function tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/);
}

function checkMermaid(body, fenceLine, add) {
  const lines = body.map((text) => text.replace(/%%.*$/, ""));
  let first = lines.findIndex((text) => text.trim() && text.trim() !== "---");
  // 跳过 mermaid 自带的 --- 配置头
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) first = lines.findIndex((text, index) => index > end && text.trim());
  }
  if (first < 0) return;
  const type = lines[first].trim().split(/\s+/)[0].toLowerCase();
  const lineOf = (index) => fenceLine + 1 + index;

  if (QUOTE_REQUIRED.has(type)) {
    const offending = lines.findIndex((text, index) => index >= first && CJK.test(text.replace(/"[^"]*"/g, "")));
    if (offending >= 0) {
      const verified = type.startsWith("xychart") ? "加双引号（已实测能出图）" : "加双引号或改用英文（加引号写法未单独实测，发布后到飞书确认）";
      add("error", "mermaid-unquoted-cjk", lineOf(offending), `${lines[first].trim().split(/\s+/)[0]} 里的中文没加引号，飞书小组件不出图：${verified}`);
    }
    return;
  }

  if (type === "flowchart" || type === "graph") {
    let labels = 0;
    let quoted = 0;
    for (const text of lines.slice(first + 1)) {
      for (const match of text.matchAll(/[\w\u3400-\u9fff]\s*(\(\[|\[\[|\[\(|\(\(|\[\/|\[\\|\{\{|\[|\(|\{)\s*(")?/g)) {
        labels += 1;
        if (match[2]) quoted += 1;
      }
    }
    if (labels >= 2 && quoted === labels) {
      add("warning", "mermaid-all-quoted", lineOf(first), "流程图的标签全部加了引号：小组件能出图，但退到画板时会解析失败；只给含特殊字符的标签加引号");
    }
    return;
  }

  if (type === "sequencediagram") {
    const participants = new Set();
    let messages = 0;
    for (const text of lines.slice(first + 1)) {
      const declared = text.match(/^\s*(participant|actor)\s+(.+?)(\s+as\s+.+)?\s*$/);
      if (declared) participants.add(declared[2]);
      const message = text.match(/^\s*([^:]+?)\s*(<<)?-{1,2}(>>|>|x|\))\s*[+-]?\s*([^:]+?)\s*:/);
      if (message) {
        messages += 1;
        participants.add(message[1]);
        participants.add(message[4]);
      }
    }
    if (participants.size > 6 || messages > 20) {
      add("warning", "sequence-too-large", lineOf(first), `时序图有 ${participants.size} 个参与者、${messages} 条消息，超过 6 个或 20 条就拆图`);
    }
  }
}

export function lintMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const issues = [];
  const add = (level, rule, line, message) => issues.push({ level, rule, line, message });

  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((text, index) => index > 0 && text.trim() === "---");
    if (end > 0) start = end + 1;
  }
  // 开头的 # 标题是文档标题，不参与标题层级检查
  const firstContent = lines.findIndex((text, index) => index >= start && text.trim());
  const titleLine = firstContent >= 0 && /^#\s+\S/.test(lines[firstContent]) ? firstContent : -1;

  // 逐行都要查的行内问题：表格行也查
  const inlineChecks = (line, no) => {
    if (PUBLIC_RENDERERS.test(line)) add("error", "public-renderer", no, "引用了公共渲染服务（mermaid.ink、kroki 等），图的源码会外发：改用 ```mermaid 代码块或本地渲染的图片");
    const tag = line.match(HTML_ONLY_TAG);
    if (tag) add("warning", "html-tag", no, `<${tag[1]}> 不是飞书支持的标签，发布后按文字显示：改成 Markdown 写法`);
    for (const match of line.matchAll(/(^|[^\\$])\$(?![\s$])([^$\n]*?[^\s\\$])\$(?!\d)/g)) {
      if (CJK.test(match[2])) add("warning", "math-dollar", no, `「$${match[2]}$」会被渲染成公式：字面的 $ 写成 \\$`);
    }
    for (const match of line.matchAll(/(^|[^!])\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
      if (!/^(https?:|mailto:|tel:|#)/i.test(match[2])) {
        add("warning", "local-link", no, `链接指向本地路径 ${match[2]}，发布后失效：换成飞书文档或网页链接`);
      }
    }
  };

  const headings = [];
  const callouts = [];
  let tableEnd = -1;
  let inComment = false;
  let fence = null;
  let listContext = false;
  let paragraph = null;

  const mojibake = (text, no) => {
    if (text.includes("\uFFFD")) add("error", "replacement-char", no, "有乱码字符 U+FFFD（编码转换时损坏），先修正原文");
  };
  for (let i = start; i < lines.length; i += 1) {
    const source = lines[i];
    const no = i + 1;
    const afterBlank = i > start && !lines[i - 1].trim();

    if (fence) {
      mojibake(source, no);
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`).test(source)) {
        if (fence.lang === "mermaid") checkMermaid(fence.body, fence.line, add);
        if (fence.indent < 2) listContext = false;
        fence = null;
      } else {
        fence.body.push(source.slice(Math.min(fence.indent, source.match(/^ */)[0].length)));
      }
      continue;
    }
    // 注释不会发布：和发布预处理一样去掉注释再查（结构识别才会一致），只剩注释的行跳过
    const scanned = scanComments(source, inComment);
    inComment = scanned.inComment;
    if (scanned.touched && !scanned.stripped.trim()) continue;
    const raw = scanned.stripped;
    mojibake(raw, no);
    const open = raw.match(FENCE_OPEN);
    if (open) {
      fence = { char: open[2][0], length: open[2].length, indent: open[1].length, lang: (open[3] ?? "").toLowerCase(), line: no, body: [] };
      paragraph = null;
      continue;
    }
    if (!raw.trim()) {
      paragraph = null;
      continue;
    }

    const line = stripCodeSpans(raw);
    const indent = raw.match(/^ */)[0].length;
    if (i < tableEnd) {
      inlineChecks(line, no);
      continue;
    }

    const atx = raw.match(ATX_HEADING);
    if (atx) {
      inlineChecks(line, no);
      if (i !== titleLine) headings.push({ level: atx[1].length, text: atx[2], line: no });
      listContext = false;
      paragraph = null;
      continue;
    }
    if (paragraph && SETEXT_UNDERLINE.test(raw)) {
      headings.push({ level: raw.trim().startsWith("=") ? 1 : 2, text: paragraph.text, line: paragraph.line });
      paragraph = null;
      continue;
    }
    if (/^ {0,3}>\s*#{1,6}\s/.test(raw)) add("warning", "heading-in-callout", no, "标题放进引用或高亮块不会进飞书目录，移到块外");
    if (ALERT.test(raw) || /<callout[\s>]/.test(line)) callouts.push({ line: no });

    const ordered = raw.match(ORDERED_ITEM);
    if (ordered && !listContext && Number(ordered[2]) !== 1) {
      add("warning", "ordered-list-start", no, `有序列表从 ${ordered[2]} 开始：飞书不保留起始编号，会从 1 重排；被代码块打断的步骤，把代码块缩进到上一项里`);
    }
    // 紧跟在列表项后面、没有空行的顶格文字是该项的延续，不结束列表
    if (LIST_ITEM.test(raw)) listContext = true;
    else if (indent < 2 && afterBlank) listContext = false;

    if (line.includes("|") && TABLE_SEPARATOR.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("|")) {
      const columns = tableCells(lines[i + 1]).length;
      if (columns > 6) add("warning", "table-too-wide", no, `表格有 ${columns} 列，飞书超过 6 列会横向滚动：拆表或把次要列改成正文`);
      let longCells = 0;
      let firstLong = null;
      let row = i + 2;
      for (; row < lines.length && lines[row].includes("|") && lines[row].trim(); row += 1) {
        for (const cell of tableCells(stripCodeSpans(lines[row]))) {
          if (sentenceCount(cell.replace(/<br\s*\/?>/gi, " ")) > 2) {
            longCells += 1;
            firstLong ??= row + 1;
          }
        }
      }
      if (longCells) add("warning", "table-long-cell", firstLong, `表格里有 ${longCells} 个单元格超过两句话，改用列表或正文`);
      tableEnd = row;
      inlineChecks(line, no);
      paragraph = null;
      continue;
    }

    inlineChecks(line, no);
    paragraph = LIST_ITEM.test(raw) || /^ {0,3}>/.test(raw) ? null : { text: raw.trim(), line: no };
  }

  if (headings.length) {
    const top = Math.min(...headings.map((heading) => heading.level));
    if (Math.max(...headings.map((heading) => heading.level)) - top >= 4) {
      const deep = headings.find((heading) => heading.level - top >= 4);
      add("warning", "heading-too-deep", deep.line, "标题超过四级：标题用到三级、最多四级，更细的内容改成列表或加粗短句");
    }
    for (let k = 1; k < headings.length; k += 1) {
      if (headings[k].level - headings[k - 1].level > 1) {
        add("warning", "heading-skip", headings[k].line, `标题从 ${headings[k - 1].level} 级跳到 ${headings[k].level} 级，不要跳级`);
      }
    }
    const chinese = headings.find((heading) => CHINESE_NUMBERING.test(heading.text));
    const decimal = headings.find((heading) => DECIMAL_NUMBERING.test(heading.text));
    if (chinese && decimal) {
      add("warning", "heading-numbering-mixed", Math.max(chinese.line, decimal.line), `标题编号混用「${chinese.text}」和「${decimal.text}」两种体系，二选一`);
    }
    // 每个顶层章节最多一个高亮块
    const sections = headings.filter((heading) => heading.level === top).map((heading) => heading.line);
    const sectionOf = (line) => sections.filter((headingLine) => headingLine < line).length;
    const seen = new Map();
    for (const callout of callouts) {
      const key = sectionOf(callout.line);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (seen.get(key) === 2) add("warning", "callouts-per-section", callout.line, "同一章节里有多个高亮块：每章最多一个，其余改成正文");
    }
  }
  return issues.sort((a, b) => a.line - b.line);
}

function runCheckMermaid(file, outDir) {
  const result = spawnSync(process.execPath, [CHECK_MERMAID, file, outDir], { encoding: "utf8", timeout: 300_000 });
  const resultsPath = join(outDir, "results.json");
  if (result.status === 1 || result.error || !existsSync(resultsPath)) {
    const reason = `${result.error?.message ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    return { status: "skipped", reason: reason || `check_mermaid.js 退出码 ${result.status}` };
  }
  return { status: "checked", blocks: JSON.parse(readFileSync(resultsPath, "utf8")) };
}

// 静态检查 + mermaid 语法校验。prepare 用 preparePublishMarkdown，由调用方传入，避免循环依赖
export function lintFile(file, { prepare, out, render = true, run = runCheckMermaid } = {}) {
  const path = resolve(file);
  if (!existsSync(path)) {
    const error = new Error(`找不到文件 ${path}`);
    error.code = "FILE_NOT_FOUND";
    throw error;
  }
  const prepared = prepare(readFileSync(path, "utf8"), { fileName: basename(path), baseDir: dirname(path), exists: existsSync });
  const errors = [...prepared.errors];
  const warnings = [...prepared.warnings];
  let mermaid = { status: prepared.diagrams.length ? "not_run" : "no_diagrams" };
  if (prepared.diagrams.length && render) {
    // 每次新建一个子目录放校验器的产物（results.md、D1.svg 等），不覆盖 --out 里已有的任何文件
    if (out) mkdirSync(resolve(out), { recursive: true });
    const outDir = mkdtempSync(join(out ? resolve(out) : tmpdir(), out ? "mermaid-" : "feishu-lint-"));
    // 只校验发布端识别出的图（注释里的、代码示例里的都不算），换行已归一；结果按顺序对回源文件行号。
    // 校验输入写进单独的临时目录，不会碰到 --out 或源文件所在目录里的同名文件；
    // 围栏比源码里最长的反引号串多一个，源码里有 ``` 行也不会被提前截断
    const inputDir = mkdtempSync(join(tmpdir(), "feishu-lint-input-"));
    const input = join(inputDir, "diagrams.md");
    writeFileSync(input, prepared.diagrams.map((diagram) => {
      const fence = "`".repeat(Math.max(3, ...(diagram.code.match(/`+/g) ?? []).map((run) => run.length + 1)));
      return `## 第 ${diagram.line} 行\n\n${fence}mermaid\n${diagram.code}\n${fence}\n`;
    }).join("\n"));
    const checked = run(input, outDir);
    // 用完就删：校验输入一律删；没给 --out 时渲染产物也不留
    rmSync(inputDir, { recursive: true, force: true });
    if (!out) rmSync(outDir, { recursive: true, force: true });
    mermaid = { status: checked.status, reason: checked.reason, ...(out ? { outDir } : {}) };
    if (checked.status === "skipped") {
      warnings.push(`mermaid 语法没校验（${checked.reason}）：手动跑 node ${CHECK_MERMAID} ${path} <输出目录>`);
    } else if ((checked.blocks ?? []).length !== prepared.diagrams.length) {
      warnings.push(`发布会建 ${prepared.diagrams.length} 张图，语法校验只返回 ${(checked.blocks ?? []).length} 张结果：逐张核对`);
    }
    (checked.blocks ?? []).forEach((block, index) => {
      const line = prepared.diagrams[index]?.line ?? "?";
      const entries = Object.entries(block.results);
      const modern = entries.filter(([version]) => parseInt(version, 10) >= 10);
      const legacy = entries.filter(([version]) => parseInt(version, 10) < 10);
      const failed = ([, status]) => status !== "ok";
      if (modern.some(failed)) {
        errors.push(`第 ${line} 行：mermaid 图解析失败，飞书小组件不会出图：${modern.find(failed)[1]}`);
      } else if (legacy.some(failed)) {
        warnings.push(`第 ${line} 行：mermaid 图在 mermaid ${legacy.find(failed)[0]} 解析失败（飞书小组件正常，GitLab 等旧版渲染可能不出图）：${legacy.find(failed)[1]}`);
      }
    });
    mermaid.checked = checked.blocks?.length ?? 0;
  }
  return {
    status: errors.length ? "errors" : warnings.length ? "warnings" : "ok",
    file: path,
    title: prepared.title,
    expected: prepared.expected,
    errors,
    warnings,
    mermaid,
  };
}
