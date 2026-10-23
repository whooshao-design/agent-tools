'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeScenario, routeFor, loadScenario } = require('../scripts/ui_check');

const SCRIPT = path.join(__dirname, '../scripts/ui_check.js');
const toolDir = path.join(os.homedir(), 'tools/lexiao-browser');
const hasBrowserRuntime = fs.existsSync(path.join(toolDir, 'package.json'))
  && fs.existsSync(path.join(toolDir, 'browsers/chrome-linux64/chrome'));

test('scenario arrays put own rules before base rules; objects merge by key', () => {
  const merged = mergeScenario(
    { mocks: [{ match: 'a', json: 1 }], sessionStorage: { x: 1, y: 1 }, url: 'base' },
    { mocks: [{ match: 'b', json: 2 }], sessionStorage: { y: 2 }, url: 'own', extends: 'base.json' },
  );
  assert.deepEqual(merged.mocks.map((m) => m.match), ['b', 'a']);
  assert.deepEqual(merged.sessionStorage, { x: 1, y: 2 });
  assert.equal(merged.url, 'own');
  assert.equal(merged.extends, undefined);
});

test('loadScenario resolves extends relative to the scenario file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-scn-'));
  try {
    fs.writeFileSync(path.join(dir, 'base.json'), JSON.stringify({ passthrough: ['cdn'], target: '.base' }));
    fs.writeFileSync(path.join(dir, 'own.json'), JSON.stringify({ extends: 'base.json', url: 'http://x/', target: '.own' }));
    const s = loadScenario(path.join(dir, 'own.json'));
    assert.deepEqual(s.passthrough, ['cdn']);
    assert.equal(s.target, '.own');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('routeFor: rewrite, then mocks, then passthrough, then defaultMock, else abort', () => {
  const scenario = {
    rewrite: [{ match: '^https://app\\.example\\.com/(?!api/)', to: 'https://127.0.0.1:8116/' }],
    mocks: [{ match: '/api/user\\.json', json: { id: 1 } }],
    passthrough: ['^https://cdn\\.example\\.com/'],
    defaultMock: { match: '/api/', json: { retcode: 0 } },
  };
  assert.deepEqual(routeFor('https://app.example.com/main.js', scenario), { action: 'rewrite', url: 'https://127.0.0.1:8116/main.js' });
  assert.equal(routeFor('https://app.example.com/api/user.json', scenario).action, 'mock');
  assert.equal(routeFor('https://cdn.example.com/a.css', scenario).action, 'continue');
  const d = routeFor('https://app.example.com/api/other.json', scenario);
  assert.equal(d.action, 'mock');
  assert.equal(d.unmatched, true);
  assert.equal(routeFor('https://tracker.example.net/x', scenario).action, 'abort');
});

const PAGE = (bodyPadding) => `<!doctype html><html><body style="margin:0;font:14px sans-serif">
<div class="dialog" style="position:absolute;left:100px;top:100px;width:420px;border:1px solid #ccc">
  <div class="body" style="padding:${bodyPadding}">
    <div style="display:flex;align-items:flex-start">
      <i class="icon" style="display:block;width:24px;height:24px;background:orange;margin-right:12px"></i>
      <div><h3 class="title" style="margin:0;line-height:24px">Copy reminder</h3><p style="margin:8px 0 0"><span>A long reminder sentence that wraps onto a second line inside the dialog, see </span><a href="#">the process document</a><span> to apply.</span></p></div>
    </div>
    <div style="text-align:right;margin-top:16px"><button class="btn">Cancel</button> <button class="btn btn-primary">Confirm</button></div>
  </div>
</div></body></html>`;

function runCheck(html, extra = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-it-'));
      const scenarioFile = path.join(dir, 'scenario.json');
      fs.writeFileSync(scenarioFile, JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}/`,
        target: '.dialog',
        passthrough: ['^http://127\\.0\\.0\\.1'],
        viewports: [{ width: 1366, height: 768 }],
        check: { align: [{ icon: '.icon', text: '.title' }] },
        ...extra,
      }));
      execFile(process.execPath, [SCRIPT, `--scenario=${scenarioFile}`, `--out=${path.join(dir, 'out')}`], (err, stdout, stderr) => {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
        if (err && err.code === 2) return reject(new Error(stderr));
        try {
          resolve({ code: err ? err.code : 0, report: JSON.parse(stdout) });
        } catch (e) {
          reject(new Error(`bad output: ${stdout}\n${stderr}`));
        }
      });
    });
  });
}

test('measured dialog with 15px padding passes', { skip: hasBrowserRuntime ? false : 'local Playwright runtime is unavailable', timeout: 60000 }, async () => {
  const { code, report } = await runCheck(PAGE('15px'));
  assert.equal(code, 0, JSON.stringify(report.results[0].findings));
  assert.equal(report.status, 'pass');
  assert.equal(report.results[0].buttons[1].toRight, 16);
});

test('buttons touching the border fail as cramped; a css step reproduces the leak', { skip: hasBrowserRuntime ? false : 'local Playwright runtime is unavailable', timeout: 60000 }, async () => {
  const { code, report } = await runCheck(PAGE('15px'), { steps: [{ css: '.dialog .body{padding:4px 0 0 0 !important}' }] });
  assert.equal(code, 1);
  const cramped = report.results[0].findings.filter((f) => f.check === 'cramped');
  assert.ok(cramped.some((f) => f.detail.includes('Confirm')), JSON.stringify(cramped));
});
