import assert from "node:assert/strict";
import test from "node:test";

import { API_ROUTES, classifyEnvelope, createTransport, fillPath, parseEnvelope } from "../scripts/lib/transport.mjs";

function recorder(responses) {
  const calls = [];
  const run = (args, options = {}) => {
    calls.push({ args, input: options.input, cwd: options.cwd });
    const next = responses.shift();
    return typeof next === "function" ? next(args) : next;
  };
  return { calls, run };
}

test("call maps API names to lark-cli api with path params, query params and a stdin body", async () => {
  const { calls, run } = recorder([{ ok: true, data: { children: [{ block_id: "b1" }] } }]);
  const transport = createTransport({ run, sleep: async () => {} });
  const data = await transport.call("docx.v1.documentBlockChildren.create", {
    path: { document_id: "doc1", block_id: "doc1" },
    params: { document_revision_id: -1, client_token: "t" },
    data: { children: [] },
    useUAT: true,
  });
  assert.deepEqual(data, { children: [{ block_id: "b1" }] });
  assert.deepEqual(calls[0].args, [
    "api",
    "POST",
    "/open-apis/docx/v1/documents/doc1/blocks/doc1/children",
    "--as",
    "user",
    "--params",
    '{"document_revision_id":-1,"client_token":"t"}',
    "--data",
    "-",
  ]);
  assert.equal(calls[0].input, '{"children":[]}');
});

test("fillPath encodes values and refuses missing path params", () => {
  assert.equal(fillPath(API_ROUTES["docx.v1.document.get"][1], { document_id: "a/b" }), "/open-apis/docx/v1/documents/a%2Fb");
  assert.throws(() => fillPath("/x/:document_id", {}), /document_id/);
});

test("writes are spaced out and rate limits are retried, reads are not throttled", async () => {
  let clock = 10_000;
  const sleeps = [];
  const { calls, run } = recorder([
    { ok: true, data: {} },
    { ok: false, error: { type: "api", subtype: "rate_limit", code: 99991400 } },
    { ok: true, data: { done: true } },
    { ok: true, data: { read: true } },
  ]);
  const transport = createTransport({
    run,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  await transport.api("POST", "/a", { data: {} });
  assert.deepEqual(await transport.api("PATCH", "/b", { data: {} }), { done: true });
  assert.deepEqual(await transport.api("GET", "/c"), { read: true });
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [350, 1000]);
});

test("lark-cli error subtypes map onto the skill's failure classes", () => {
  const cls = (error) => classifyEnvelope({ ok: false, error }).failureClass;
  assert.equal(cls({ type: "authorization", subtype: "app_scope_not_applied", missing_scopes: ["x:y"] }), "APP_PERMISSION_NOT_PUBLISHED");
  assert.equal(cls({ type: "authorization", subtype: "missing_scope", missing_scopes: ["x:y"] }), "OAUTH_SCOPE_MISSING");
  assert.equal(cls({ type: "authentication", subtype: "token_expired" }), "AUTH_REQUIRED");
  assert.equal(cls({ type: "config", subtype: "not_configured" }), "LARK_CLI_NOT_CONFIGURED");
  assert.equal(cls({ type: "api", subtype: "rate_limit", code: 99991400 }), "RATE_LIMITED");
  assert.equal(cls({ type: "authorization", subtype: "permission_denied", code: 131006 }), "DOCUMENT_ACCESS_DENIED");
  assert.equal(cls({ type: "api", subtype: "invalid_parameters", code: 1770001 }), "LARK_API_FAILED");
});

test("failed calls throw with the classified details and keep the log id", async () => {
  const { run } = recorder([{ ok: false, error: { type: "api", subtype: "unknown", code: 1770035, message: "resource count exceed limit", log_id: "L1" } }]);
  const transport = createTransport({ run, sleep: async () => {} });
  await assert.rejects(transport.api("POST", "/x", { data: {} }), (error) => {
    assert.equal(error.code, 1770035);
    assert.equal(error.details.failureClass, "LARK_API_FAILED");
    assert.equal(error.details.logId, "L1");
    return true;
  });
});

test("parseEnvelope tolerates event lines before the final JSON", () => {
  assert.deepEqual(parseEnvelope('{"ok":true,"data":{}}'), { ok: true, data: {} });
  assert.deepEqual(parseEnvelope("", 'noise\n{"ok":false,"error":{"code":1}}\n'), { ok: false, error: { code: 1 } });
  assert.equal(parseEnvelope("not json", ""), null);
});
