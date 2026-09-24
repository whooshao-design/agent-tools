import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { buildCleanupList, cleanupChecklist, readRegistry, recordCreated, writeRegistry } from "../scripts/lib/cleanup.mjs";
import { LarkCliError } from "../scripts/lib/transport.mjs";
import { tempDir } from "./temp.mjs";

test("created documents are recorded, read back and rewritten", () => {
  const path = join(tempDir("feishu-registry-"), "created.jsonl");
  assert.deepEqual(readRegistry(path), []);
  recordCreated({ doc_token: "A", parent_token: "F", source: "publish" }, path);
  recordCreated({ doc_token: "B", parent_token: "F", source: "create-doc" }, path);
  assert.deepEqual(readRegistry(path).map((entry) => entry.doc_token), ["A", "B"]);
  assert.ok(readRegistry(path)[0].created_at);
  writeRegistry(readRegistry(path).filter((entry) => entry.doc_token !== "A"), path);
  assert.deepEqual(readRegistry(path).map((entry) => entry.doc_token), ["B"]);
});

test("cleanup list reads current titles and tells deleted documents apart from unknown failures", async () => {
  const transport = {
    async call(name, args) {
      assert.equal(name, "docx.v1.document.get");
      const token = args.path.document_id;
      if (token === "A") return { document: { title: "探针 A" } };
      if (token === "B") throw new LarkCliError("not found", { ok: false, error: { type: "api", subtype: "unknown", code: 1770002 } });
      throw new LarkCliError("boom", { ok: false, error: { type: "api", subtype: "unknown", code: 1770032 } });
    },
  };
  const items = await buildCleanupList(
    transport,
    [
      { doc_token: "A", parent_token: "TEST" },
      { doc_token: "B", parent_token: "TEST", title: "探针 B" },
      { doc_token: "C", title: "来路不明" },
    ],
    { testFolderToken: "TEST" },
  );
  assert.deepEqual(items.map((item) => [item.docToken, item.status, item.title]), [
    ["A", "exists", "探针 A"],
    ["B", "deleted", "探针 B"],
    ["C", "unknown", "来路不明"],
  ]);
  assert.equal(items[0].folder.label, "测试目录（FEISHU_TEST_FOLDER）");
  assert.equal(items[0].folder.url, "https://lexin.feishu.cn/drive/folder/TEST");

  const checklist = cleanupChecklist(items);
  assert.match(checklist, /目录：测试目录（FEISHU_TEST_FOLDER） https:\/\/lexin\.feishu\.cn\/drive\/folder\/TEST\n- \[ \] 探针 A — https:\/\/lexin\.feishu\.cn\/docx\/A/);
  assert.doesNotMatch(checklist, /探针 B/);
  assert.match(checklist, /目录：未知.*\n- \[ \] 来路不明 — .*（状态未确认）/);
  assert.equal(cleanupChecklist(items.filter((item) => item.status === "deleted")), "没有需要手动删除的文档。");
});
