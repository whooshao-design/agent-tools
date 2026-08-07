'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('../scripts/browser_session');

const toolDir = path.join(os.homedir(), 'tools/lexiao-browser');
const hasBrowserRuntime = fs.existsSync(path.join(toolDir, 'package.json'))
  && fs.existsSync(path.join(toolDir, 'browsers/chrome-linux64/chrome'));

test('authenticated request persists Set-Cookie across browser processes', {
  skip: hasBrowserRuntime ? false : 'local Playwright runtime is unavailable',
  timeout: 30000,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-session-integration-'));
  const profile = path.join(directory, 'profile');
  const server = http.createServer((request, response) => {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/set') {
      response.setHeader('Set-Cookie', 'renewed=1; Path=/; Max-Age=3600; HttpOnly');
    }
    response.end(JSON.stringify({ cookie: request.headers.cookie || '' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const previousArgv = process.argv;
  const previousRequest = process.env.BROWSER_SESSION_REQUEST_JSON;
  const previousNoProxy = process.env.NO_PROXY;
  const previousLog = console.log;
  const output = [];
  process.env.BROWSER_SESSION_REQUEST_JSON = JSON.stringify({
    method: 'GET',
    headers: {},
    timeoutMs: 10000,
    maxChars: 1000,
  });
  process.env.NO_PROXY = '127.0.0.1,localhost';
  console.log = (value) => output.push(String(value));

  try {
    process.argv = ['node', 'browser_session.js', '--request', `--url=http://127.0.0.1:${port}/set`, `--profile=${profile}`];
    await main();
    process.argv = ['node', 'browser_session.js', '--request', `--url=http://127.0.0.1:${port}/echo`, `--profile=${profile}`];
    await main();
    process.argv = [
      'node',
      'browser_session.js',
      '--ensure',
      `--url=http://127.0.0.1:${port}/echo`,
      `--profile=${profile}`,
      '--success-text=none',
    ];
    await main();
    process.argv = [
      'node',
      'browser_session.js',
      '--renew',
      '--headed',
      `--url=http://127.0.0.1:${port}/echo`,
      `--profile=${profile}`,
      '--success-text=none',
    ];
    await main();
    process.argv = ['node', 'browser_session.js', '--doctor', `--profile=${profile}`];
    await main();
    process.argv = [
      'node',
      'browser_session.js',
      `--url=http://127.0.0.1:${port}/echo`,
      `--profile=${profile}`,
      '--success-text=none',
    ];
    await main();

    const secondResponse = JSON.parse(output[1]);
    assert.equal(secondResponse.sessionState, 'READY');
    assert.match(secondResponse.body, /renewed=1/);
    const ensured = JSON.parse(output[2]);
    assert.equal(ensured.ensureStrategy, 'headless-fast-path');
    const renewal = JSON.parse(output[3]);
    assert.equal(renewal.renewalState, 'SESSION_ACTIVE');
    assert.equal(renewal.browserMode, 'headless');
    assert.equal('snippet' in renewal, false);
    assert.equal('buttons' in renewal, false);
    const doctor = JSON.parse(output[4]);
    assert.equal(doctor.profileDir, profile);
    const status = JSON.parse(output[5]);
    assert.equal(status.sessionState, 'READY');
  } finally {
    process.argv = previousArgv;
    if (previousRequest === undefined) delete process.env.BROWSER_SESSION_REQUEST_JSON;
    else process.env.BROWSER_SESSION_REQUEST_JSON = previousRequest;
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
    console.log = previousLog;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
