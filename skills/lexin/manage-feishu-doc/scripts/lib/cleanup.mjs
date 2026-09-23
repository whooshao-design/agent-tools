// 本 skill 不申请删除权限（space:document:delete / drive:drive）。需要删文档时列出
// 「文档名 + 链接 + 所在目录」交给用户在飞书里手动删；删完再核对并清理本地记录。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DELETED_CODES = new Set([1770002, 1770003]);

export function registryPath() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "agent-tools/feishu-created-docs.jsonl");
}

export function folderUrl(token) {
  return token ? `https://lexin.feishu.cn/drive/folder/${token}` : null;
}

// 每次经本 skill 新建文档都记一笔，cleanup-list 据此给出删除清单
export function recordCreated(entry, path = registryPath()) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ ...entry, created_at: entry.created_at ?? new Date().toISOString() })}\n`);
}

export function readRegistry(path = registryPath()) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function writeRegistry(entries, path = registryPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
}

function folderLabel(token, testFolderToken) {
  if (!token) return "未知（在飞书里打开文档查看所在位置）";
  return token === testFolderToken ? "测试目录（FEISHU_TEST_FOLDER）" : "文件夹";
}

// 逐篇查当前标题；查不到（已删）的标出来，供 --prune 清理记录
export async function buildCleanupList(transport, candidates, { testFolderToken = null } = {}) {
  const items = [];
  for (const candidate of candidates) {
    const item = {
      docToken: candidate.doc_token,
      url: candidate.url ?? `https://lexin.feishu.cn/docx/${candidate.doc_token}`,
      title: candidate.title ?? null,
      folder: {
        token: candidate.parent_token ?? null,
        url: folderUrl(candidate.parent_token),
        label: folderLabel(candidate.parent_token, testFolderToken),
      },
      source: candidate.source ?? null,
      createdAt: candidate.created_at ?? null,
    };
    try {
      const value = await transport.call("docx.v1.document.get", { path: { document_id: candidate.doc_token } });
      item.title = value?.document?.title ?? item.title;
      item.status = "exists";
    } catch (error) {
      const code = error?.envelope?.error?.code ?? error?.code;
      const subtype = error?.envelope?.error?.subtype;
      item.status = DELETED_CODES.has(code) || subtype === "not_found" ? "deleted" : "unknown";
      item.error = item.status === "unknown" ? String(error.message).slice(0, 200) : undefined;
    }
    items.push(item);
  }
  return items;
}

export function cleanupChecklist(items) {
  const pending = items.filter((item) => item.status !== "deleted");
  if (pending.length === 0) return "没有需要手动删除的文档。";
  const byFolder = new Map();
  for (const item of pending) {
    const key = item.folder.url ?? "未知目录";
    if (!byFolder.has(key)) byFolder.set(key, { folder: item.folder, items: [] });
    byFolder.get(key).items.push(item);
  }
  const lines = ["请在飞书里手动删除以下文档（删除后可运行 cleanup-list --prune 核对）："];
  for (const { folder, items: group } of byFolder.values()) {
    lines.push("", folder.url ? `目录：${folder.label} ${folder.url}` : `目录：${folder.label}`);
    for (const item of group) {
      const note = item.status === "unknown" ? "（状态未确认）" : "";
      lines.push(`- [ ] ${item.title ?? "（标题未知）"} — ${item.url}${note}`);
    }
  }
  return lines.join("\n");
}
