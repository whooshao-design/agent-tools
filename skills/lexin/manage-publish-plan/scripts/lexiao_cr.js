#!/usr/bin/env node
'use strict';
// List and create Lexiao Phabricator code reviews (lexiao.oa.fenqile.com/#/phabricator-cr) before a frontend
// publish plan. Reads call lexiao-api with fetch(credentials: 'include') inside a logged-in Lexiao page; cookies never
// leave the browser. create fills the real 创建CodeReview dialog and, without --dry-run, clicks 确 定 and confirms
// "此操作将发起phabricator CR"; with --dry-run the create endpoint is aborted and nothing is sent.
// Order for a frontend branch: merge origin/<compare> into the branch -> CR -> CR通过 -> merge the branch into <compare>.
// A branch already contained in <compare> has an empty diff and Lexiao marks its CR 无需CR, so create refuses it;
// manage-publish-order merge calls crGate() to refuse merging a branch without a passed CR.
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const { createRequire } = require('module');

const BROWSER_SESSION_DIR = '/home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts';
const { launchLockedContext, resolvePaths } = require(path.join(BROWSER_SESSION_DIR, 'browser_session.js'));
const { buildBrowserEnv, chromiumArgsFor } = require(path.join(BROWSER_SESSION_DIR, 'browser_network.js'));

const LEXIAO_HOST = 'lexiao.oa.fenqile.com';
const LEXIAO_HOME = `https://${LEXIAO_HOST}/`;
const CR_PAGE = `${LEXIAO_HOME}#/phabricator-cr`;
const API = 'https://lexiao-api.oa.fenqile.com/oa/lexiao/codereview';
const CREATE_PATH = /\/codereview\/create_code_review\.json/;
const READY_TIMEOUT_MS = 45000;
// Remote-search selects load options after typing; wait for them instead of selecting stale ones.
const OPTION_WAIT_MS = 4000;

const USAGE = `Usage:
  node lexiao_cr.js list   [--demand=<TAPD ID>] [--project=<工程名>] [--limit=N]
  node lexiao_cr.js create --repo=<本地仓库> --demand=<TAPD ID> --group=<GitLab组> --project=<工程名>
                           --branch=<评审分支> --compare=<对比分支> --reviewers=<a,b> [--cc=<a,b>] [--dry-run]

Common: [--profile <dir>] (default: get-browser-session main profile)
group is the GitLab group in the repo remote (web_mihawk_oa: rc_fd). create first checks in --repo that
origin/<branch> is pushed, contains origin/<compare> and is not yet merged into it. Diff范围 is decided by the page
(first CR of a branch is locked to 全量). create without --dry-run sends review invitations.`;

class CrError extends Error {}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const eq = item.indexOf('=');
    if (eq > 2) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[item.slice(2)] = next;
      index += 1;
    } else {
      args[item.slice(2)] = true;
    }
  }
  return args;
}

function argText(value) {
  return value === undefined || value === true ? '' : String(value).trim();
}

function nameList(value) {
  return [...new Set(argText(value).split(',').map((item) => item.trim()).filter(Boolean))];
}

function validateCreate(args) {
  const spec = {};
  for (const field of ['repo', 'demand', 'group', 'project', 'branch', 'compare']) {
    spec[field] = argText(args[field]);
    if (!spec[field]) throw new CrError(`--${field} is required`);
  }
  if (!/^\d+$/.test(spec.demand)) throw new CrError(`--demand must be a TAPD story id: ${spec.demand}`);
  if (spec.branch === spec.compare) throw new CrError('--branch and --compare must differ');
  spec.reviewers = nameList(args.reviewers);
  if (!spec.reviewers.length) throw new CrError('--reviewers is required');
  spec.cc = nameList(args.cc);
  return spec;
}

// Option texts may carry suffixes on later lines (e.g. "jianquanma\n开发SE应用负责人 职级符合"); match the first line exactly.
function exactOptionIndex(texts, wanted) {
  const hits = texts.map((text, index) => [String(text).split('\n')[0].trim(), index]).filter(([name]) => name === wanted);
  if (hits.length !== 1) return { index: -1, count: hits.length };
  return { index: hits[0][1], count: 1 };
}

// Decide from git facts whether a CR may be created: the diff must be non-empty and based on the latest compare branch.
function branchProblem({ branchInCompare, compareInBranch, branch, compare }) {
  if (branchInCompare) {
    return `origin/${branch} is already contained in origin/${compare}: the CR diff is empty and Lexiao marks it 无需CR. `
      + `Create the CR before merging into ${compare}.`;
  }
  if (!compareInBranch) {
    return `origin/${branch} does not contain the latest origin/${compare}; merge origin/${compare} into ${branch}, push, then create the CR.`;
  }
  return '';
}

// Merge gate: the latest CR of the branch must be created after its last commit and be CR通过. 无需CR also passes
// when an earlier record of the branch is CR通过: an incremental CR whose only new commit merges the release branch
// has an empty diff. 无需CR without any earlier CR通过 (e.g. a branch already merged before its CR) does not pass.
function crGate(rows, branch, lastCommitMs) {
  const own = rows.filter((row) => row.branch === branch).sort((a, b) => b.createTime - a.createTime);
  if (!own.length) return { ok: false, reason: `no Lexiao CR record for ${branch}; create one with lexiao_cr.js create` };
  const latest = own[0];
  const passed = latest.statusCode === 'CR_PASS'
    || (latest.statusCode === 'NO_CR_NEEDED' && own.slice(1).some((row) => row.statusCode === 'CR_PASS'));
  if (!passed) {
    return { ok: false, row: latest, reason: `latest CR ${latest.id} of ${branch} is ${latest.status} (${latest.statusCode}), not CR通过` };
  }
  if (latest.createTime < lastCommitMs) {
    return { ok: false, row: latest, reason: `CR ${latest.id} was created before the last commit of ${branch}; create an incremental CR` };
  }
  return { ok: true, row: latest, reason: '' };
}

function summarizeRow(row) {
  return {
    id: row.code_review_id,
    project: row.project_name,
    branch: row.branch_name,
    compare: row.compare_branch_name,
    status: row.front_code_review_status_desc,
    statusCode: row.front_code_review_status,
    createTime: Number(row.create_time) || 0,
    stage: row.demand_stage_desc,
    diff: row.eval_diff_model,
    reviewers: row.reviewers,
    cc: row.cc_recipients,
    creator: row.creator,
    url: row.code_review_url || '',
  };
}

// ---------- git ----------

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function isAncestor(repo, ancestor, ref) {
  try { git(repo, ['merge-base', '--is-ancestor', ancestor, ref]); return true; } catch (_) { return false; }
}

function checkBranches(spec) {
  const repo = path.resolve(spec.repo);
  let fetched = false;
  for (let attempt = 0; attempt < 3 && !fetched; attempt += 1) {
    try { git(repo, ['fetch', '-q', 'origin', spec.compare, spec.branch]); fetched = true; } catch (error) {
      if (attempt === 2) throw new CrError(`git fetch failed in ${repo}: ${String(error.stderr || error.message).trim()}`);
    }
  }
  const local = (() => { try { return git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${spec.branch}`]); } catch (_) { return ''; } })();
  if (local && local !== git(repo, ['rev-parse', `origin/${spec.branch}`])) {
    throw new CrError(`${spec.branch} differs from origin/${spec.branch}; push or pull it first so the CR covers the local commits`);
  }
  const problem = branchProblem({
    branchInCompare: isAncestor(repo, `origin/${spec.branch}`, `origin/${spec.compare}`),
    compareInBranch: isAncestor(repo, `origin/${spec.compare}`, `origin/${spec.branch}`),
    branch: spec.branch,
    compare: spec.compare,
  });
  if (problem) throw new CrError(problem);
  console.log(`git: origin/${spec.branch} contains origin/${spec.compare} and has ${git(repo, ['rev-list', '--count', `origin/${spec.compare}..origin/${spec.branch}`])} commit(s) to review`);
}

// ---------- browser ----------

function loadPlaywright(paths) {
  if (!fs.existsSync(paths.playwrightPackage)) throw new CrError(`Playwright tool dir not found: ${paths.toolDir}`);
  if (!fs.existsSync(paths.chromePath)) throw new CrError(`Chrome not found: ${paths.chromePath}`);
  return createRequire(paths.playwrightPackage)('playwright').chromium;
}

async function openBrowser(paths, chromium, guard) {
  const network = buildBrowserEnv(LEXIAO_HOME, { ...process.env });
  const env = { ...network.env, LD_LIBRARY_PATH: [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  const context = await launchLockedContext(chromium, paths.profileDir, {
    executablePath: paths.chromePath,
    headless: true,
    env,
    viewport: { width: 1440, height: 900 },
    args: chromiumArgsFor(LEXIAO_HOME, ['--no-sandbox']),
  });
  try {
    await context.route(CREATE_PATH, (route) => {
      if (guard.allowCreate) return route.continue();
      guard.blocked.push(route.request().url());
      return route.abort();
    });
    const page = context.pages()[0] || await context.newPage();
    return { context, page };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function gotoPage(page, url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      break;
    } catch (error) {
      if (attempt >= 3 || !/net::ERR_/.test(String(error && error.message))) throw error;
      await page.waitForTimeout(3000 * attempt);
    }
  }
  const host = new URL(page.url()).hostname;
  if (host !== LEXIAO_HOST) {
    throw new CrError(`Lexiao login required (landed on ${host}); run get-browser-session ensure_session with url=${LEXIAO_HOME}`);
  }
}

async function listRows(page, { demand = '', project = '', limit = 10 }) {
  const query = new URLSearchParams({ demand_id: demand, project_name: project, page: '1', limit: String(limit) });
  const out = await page.evaluate(async (url) => {
    const resp = await fetch(url, { credentials: 'include' });
    return { status: resp.status, text: await resp.text() };
  }, `${API}/page_code_review.json?${query}`);
  let json = null;
  try { json = JSON.parse(out.text); } catch (error) { /* reported below */ }
  if (out.status !== 200 || !json || !Array.isArray(json.result_rows)) {
    throw new CrError(`page_code_review failed: HTTP ${out.status} ${out.text.slice(0, 200)}`);
  }
  return json.result_rows.map(summarizeRow);
}

async function cmdList(page, args) {
  await gotoPage(page, LEXIAO_HOME);
  const limit = Number(argText(args.limit) || 10);
  const rows = await listRows(page, { demand: argText(args.demand), project: argText(args.project), limit });
  console.log(JSON.stringify(rows, null, 2));
}

async function cmdCreate(page, args, guard) {
  const spec = validateCreate(args);
  const dryRun = Boolean(args['dry-run']);
  await gotoPage(page, CR_PAGE);
  const opener = page.getByText('创建CodeReview').first();
  await opener.waitFor({ timeout: READY_TIMEOUT_MS });
  await opener.click();
  const dialog = page.locator('.el-dialog:visible').filter({ hasText: '评审工程' });
  await dialog.waitFor({ timeout: READY_TIMEOUT_MS });
  const item = (label) => dialog.locator('.el-form-item').filter({ has: page.locator('label', { hasText: label }) });

  // Type into the select (multi-selects have their own el-select__input) and click the single exact option.
  const pick = async (label, wanted, keyword) => {
    const multi = item(label).locator('input.el-select__input');
    const input = (await multi.count()) ? multi.first() : item(label).locator('input').last();
    await item(label).locator('.el-select').first().click();
    await input.fill('');
    await input.type(keyword || wanted, { delay: 30 });
    await page.waitForTimeout(OPTION_WAIT_MS);
    const options = page.locator('.el-select-dropdown:visible .el-select-dropdown__item');
    const texts = await options.allInnerTexts();
    const { index, count } = exactOptionIndex(texts, wanted);
    if (index < 0) {
      throw new CrError(`${label}: ${count} exact matches for ${wanted}; options: ${texts.slice(0, 15).map((t) => t.split('\n')[0]).join(' | ')}`);
    }
    await options.nth(index).click();
    await page.waitForTimeout(1000);
  };

  const demandInput = item('需求ID').locator('input');
  await demandInput.fill(spec.demand);
  await demandInput.press('Tab');
  await page.waitForTimeout(3000);
  await pick('Group', spec.group);
  await pick('评审工程', spec.project);
  // The branch list holds hundreds of entries; search by the distinctive middle part of rel_<name>_<id>.
  await pick('评审分支', spec.branch, spec.branch.replace(/^rel_/, '').replace(/_\d+$/, ''));
  await pick('对比分支', spec.compare);
  for (const name of spec.reviewers) await pick('评审人员', name);
  await dialog.locator('label', { hasText: '评审人员' }).click();
  for (const name of spec.cc) await pick('抄送人', name);
  if (spec.cc.length) await dialog.locator('label', { hasText: '抄送人' }).click();
  await page.waitForTimeout(800);

  const form = await dialog.evaluate((node) => [...node.querySelectorAll('.el-form-item')].map((formItem) => {
    const label = (formItem.querySelector('label') || {}).innerText || '';
    const tags = [...formItem.querySelectorAll('.el-tag')].map((tag) => tag.innerText.trim()).filter(Boolean);
    const values = [...formItem.querySelectorAll('input.el-input__inner')].map((input) => input.value).filter(Boolean);
    const radio = formItem.querySelector('.el-radio.is-checked');
    return { label: label.replace(/[:：]\s*$/, '').trim(), value: tags.length ? tags : values.join(','), radio: radio ? radio.innerText.trim() : '' };
  }));
  console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'create', form }, null, 2));
  if (dryRun) {
    console.log('dry-run: 未点"确 定"，没有发起 CR。');
    return;
  }

  guard.allowCreate = true;
  const created = page.waitForResponse((resp) => CREATE_PATH.test(resp.url()), { timeout: 60000 });
  await dialog.getByRole('button', { name: /确\s*定/ }).click();
  const box = page.locator('.el-message-box:visible').filter({ hasText: '发起phabricator CR' });
  await box.waitFor({ timeout: 15000 });
  await box.getByRole('button', { name: /确\s*定/ }).click();
  const resp = await created;
  const body = await resp.json().catch(() => null);
  const id = body && Array.isArray(body.result_rows) && body.result_rows[0] && body.result_rows[0].code_review_id;
  if (!id) throw new CrError(`create_code_review returned no code_review_id: HTTP ${resp.status()} ${JSON.stringify(body).slice(0, 300)}`);
  const rows = await listRows(page, { demand: spec.demand, project: spec.project, limit: 5 });
  const row = rows.find((r) => r.id === id);
  if (!row) throw new CrError(`created code_review_id ${id} not found in the list`);
  const mismatch = [];
  if (row.branch !== spec.branch) mismatch.push(`branch=${row.branch}`);
  if (row.compare !== spec.compare) mismatch.push(`compare=${row.compare}`);
  if (nameList(row.reviewers).join() !== spec.reviewers.join()) mismatch.push(`reviewers=${row.reviewers}`);
  if (nameList(row.cc).join() !== spec.cc.join()) mismatch.push(`cc=${row.cc}`);
  console.log(JSON.stringify({ created: row, mismatch }, null, 2));
  if (mismatch.length) throw new CrError(`read-back mismatch: ${mismatch.join(', ')}`);
}

const COMMANDS = { list: cmdList, create: cmdCreate };

async function withLexiaoPage(args, fn) {
  const paths = resolvePaths(args, LEXIAO_HOME);
  const chromium = loadPlaywright(paths);
  const guard = { allowCreate: false, blocked: [] };
  const { context, page } = await openBrowser(paths, chromium, guard);
  try {
    return await fn(page, guard);
  } finally {
    if (guard.blocked.length) console.log(`blocked (dry-run): ${guard.blocked.join(', ')}`);
    await context.close().catch(() => {});
  }
}

// Used by manage-publish-order: CR records of one requirement and project.
async function queryCodeReviews({ demand, project, profile }) {
  return withLexiaoPage({ profile }, async (page) => {
    await gotoPage(page, LEXIAO_HOME);
    return listRows(page, { demand, project, limit: 50 });
  });
}

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!COMMANDS[command] || args.help) {
    console.log(USAGE);
    return command || args.help ? 0 : 2;
  }
  if (command === 'create') checkBranches(validateCreate(args));
  await withLexiaoPage(args, (page, guard) => COMMANDS[command](page, args, guard));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error && error.message ? error.message : String(error));
      process.exit(1);
    });
}

module.exports = { branchProblem, crGate, exactOptionIndex, nameList, parseArgs, queryCodeReviews, summarizeRow, validateCreate };
