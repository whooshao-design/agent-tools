const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRequest, rowsOf, buildAddBody, main } = require('../scripts/lexiao_nexus_upload');

const createArgs = ['create', '--jar-id=2418', '--name-like=process-engine-console', '--branch=rel_x_1',
  '--demand-id=1426731', '--remark=说明'];
const info = { id: 2418, name: 'process-engine-console-java', type: 'INNER_GROUP', git_addr: 'http://git/x.git' };
const ok = (rows) => ({ status: 200, text: JSON.stringify({ retcode: 0, result_rows: rows }) });

function browser(responses) {
  const calls = [];
  const page = {
    goto: async () => {}, waitForTimeout: async () => {},
    evaluate: async (_fn, request) => { calls.push(request); return responses.shift(); },
  };
  return { calls, open: async () => ({ pages: () => [page], close: async () => {} }) };
}

test('create needs every field and defaults to snapshot without applying', () => {
  const req = parseRequest(createArgs);
  assert.equal(req.versionType, 'snapshot');
  assert.equal(req.apply, false);
  for (const drop of ['--jar-id', '--branch', '--demand-id', '--remark', '--name-like']) {
    assert.throws(() => parseRequest(createArgs.filter((a) => !a.startsWith(drop))));
  }
  assert.throws(() => parseRequest([...createArgs, '--version-type=beta']), /snapshot/);
});

test('unknown command and bad ids fail before opening a browser', async () => {
  for (const argv of [['delete'], ['status', '--deploy-id=1&x=2'], ['upload', '--deploy-id=3']]) {
    let opened = false;
    await assert.rejects(main(argv, async () => { opened = true; }));
    assert.equal(opened, false);
  }
});

test('add body matches the page request and leaves the version to the server', () => {
  const body = buildAddBody(info, parseRequest(createArgs));
  assert.deepEqual(body, {
    jar_id: 2418, jar_name: 'process-engine-console-java', jar_type: 'INNER_GROUP', jar_version: '',
    jar_version_type: 'snapshot', remark: '说明', direct_approver: '', safe_approver: '', approvers: '',
    branch: 'rel_x_1', demand_id: 1426731, git_addr: 'http://git/x.git',
  });
});

test('error responses are never treated as empty results', () => {
  assert.deepEqual(rowsOf({ status: 200, json: { retcode: 0, result_rows: [] } }, 'q'), []);
  assert.throws(() => rowsOf({ status: 200, json: { retcode: '1', retmsg: 'no auth' } }, 'q'), /no auth/);
  assert.throws(() => rowsOf({ status: 302, json: null }, 'q'));
});

test('create without --apply only previews and never posts', async () => {
  const b = browser([ok([info]), ok([{ name: 'rel_x_1', commit: { id: 'abc' } }]), ok([{ id: 1426731, name: '需求' }])]);
  await main(createArgs, b.open);
  assert.equal(b.calls.length, 3);
  assert.ok(b.calls.every((c) => !String(c.url).includes('nexus_deploy_add')));
});

test('create refuses a branch that does not exist', async () => {
  const b = browser([ok([info]), ok([{ name: 'master' }])]);
  await assert.rejects(main([...createArgs, '--apply'], b.open), /没有分支/);
  assert.ok(b.calls.every((c) => !String(c.url).includes('nexus_deploy_add')));
});

test('upload refuses an order of another jar or one already running', async () => {
  const deploy = (jarId, status) => ok([{ id: 9, jar_id: jarId, deploy_status: status }]);
  await assert.rejects(main(['upload', '--deploy-id=9', '--jar-id=1'], browser([deploy(2, 'DEPLOY_INIT')]).open), /不是 1/);
  await assert.rejects(main(['upload', '--deploy-id=9', '--jar-id=2'], browser([deploy(2, 'DEPLOYING')]).open), /不要重复点上传/);
});
