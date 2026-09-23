import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { preparePublishMarkdown } from "../scripts/lib/markdown.mjs";
import { alignUnits, diffUnits, parseTopLevel, remoteChanges, splitUnits } from "../scripts/lib/structure.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// structure.md 发布到 lexin 租户后读回的 XML（块 id、图片 token 已脱敏），覆盖段落硬换行、段落后紧跟列表、
// 松散/嵌套列表、有序列表、待办、引用、Setext 标题、分割线、表格、独立图片、段落夹图、代码、高亮块、小组件、分栏
test("local units line up one to one with the top-level elements Feishu actually produced", () => {
  const prepared = preparePublishMarkdown(fixture("structure.md"), {
    fileName: "structure.md",
    baseDir: "/probe",
    exists: () => true,
    readFile: () => "png",
  });
  const units = splitUnits(prepared.body, { diagrams: prepared.diagrams, imageHashes: prepared.imageHashes });
  const elements = parseTopLevel(fixture("structure.xml"));
  const alignment = alignUnits(units, elements);
  assert.equal(alignment.ok, true, alignment.reason);
  assert.equal(units.length, 23);
  assert.equal(elements.length, 25);
  const list = alignment.units.find((unit) => unit.kind === "list" && unit.tags[0] === "ul" && unit.blockIds.length === 4);
  assert.ok(list, "the loose and tight bullet list is one ul whose top-level blocks are its four items");
  const inlineImage = alignment.units.find((unit) => unit.tags.join("+") === "p+img+p");
  assert.equal(inlineImage.blockIds.length, 3);
  assert.equal(prepared.expected.headings, 5, "the Setext heading is counted");
});

test("parseTopLevel returns list items as top-level ids and hashes content without ids", () => {
  const [list, paragraph] = parseTopLevel('<title id="t">T</title><ul><li id="a">x<ul><li id="a1">y</li></ul></li><li id="b">z</li></ul><p id="c">正文<br/>换行</p>');
  assert.deepEqual(list.topIds, ["a", "b"]);
  assert.deepEqual(list.allIds, ["a", "a1", "b"]);
  assert.deepEqual(paragraph.topIds, ["c"]);
  assert.equal(parseTopLevel('<p id="other">正文<br/>换行</p>')[0].hash, paragraph.hash);
});

test("alignment refuses to guess when counts or kinds differ", () => {
  const units = splitUnits("# 标题\n\n段落\n");
  assert.equal(alignUnits(units, parseTopLevel('<h1 id="a">标题</h1>')).ok, false);
  assert.match(alignUnits(units, parseTopLevel('<h1 id="a">标题</h1><table id="b"></table>')).reason, /应为 p/);
});

test("diffUnits keeps matching units and reports gaps with the anchor of the last kept block", () => {
  const unit = (hash, id) => ({ hash, blockIds: [id] });
  const oldUnits = [unit("a", "A"), unit("b", "B"), unit("c", "C"), unit("d", "D")];
  const newUnits = [unit("a"), unit("b2"), unit("c"), unit("d"), unit("e")];
  assert.deepEqual(diffUnits(oldUnits, newUnits), [
    { oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2, anchor: "A" },
    { oldStart: 4, oldEnd: 4, newStart: 4, newEnd: 5, anchor: "D" },
  ]);
  assert.deepEqual(diffUnits([], [unit("x")]), [{ oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 1, anchor: null }]);
});

test("remoteChanges flags edited or vanished units and blocks that belong to no unit", () => {
  const before = parseTopLevel('<p id="a">一</p><p id="b">二</p>');
  const units = alignUnits(splitUnits("一\n\n二\n"), before).units;
  const after = parseTopLevel('<p id="a">一（改）</p><p id="n">新</p>');
  const changes = remoteChanges(units, after);
  assert.deepEqual(changes.changed, [0, 1]);
  assert.deepEqual(changes.inserted.map((element) => element.topIds[0]), ["n"]);
  assert.deepEqual(remoteChanges(units, before), { changed: [], inserted: [] });
});

test("mermaid units hash by their code, so renumbered placeholders do not look like edits", () => {
  const first = splitUnits("[[feishu-mermaid:1]]\n", { diagrams: [{ index: 1, code: "flowchart LR\n  A-->B" }] });
  const second = splitUnits("[[feishu-mermaid:2]]\n", { diagrams: [{ index: 2, code: "flowchart LR\n  A-->B" }] });
  assert.equal(first[0].hash, second[0].hash);
});
