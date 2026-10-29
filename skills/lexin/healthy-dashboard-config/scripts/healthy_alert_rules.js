#!/usr/bin/env node
'use strict';

// 雷神告警规则：按指标列举、按模板新建。雷神改过 Nightingale，规则只能按「业务组 → 分类」读写：
//   GET  /api/n9e/busi-groups/{gid}/categories
//   GET  /api/n9e/busi-group/{gid}/category/{cid}/alert-rules
//   POST /api/n9e/busi-group/{gid}/category/{cid}/alert-rules   body 为规则数组，返回 dat.success / dat.failed
//   GET  /api/n9e/alert-rule/{id}
// 标准的 /api/n9e/busi-group/{gid}/alert-rules 读写都返回 404。

const fs = require('fs');
const { parseArgs, withHealthyClient } = require('./healthy_client');

// 模板规则里属于「那一条规则本身」的字段，新建时不能带过去。
const TEMPLATE_DROP_FIELDS = ['0', 'id', 'create_at', 'create_by', 'update_at', 'update_by', 'cur_event_count', 'notify_groups_obj'];
const REQUIRED_RULE_FIELDS = ['name', 'prom_ql'];

function listOf(dat) {
  if (Array.isArray(dat)) return dat;
  return (dat && dat.list) || [];
}

function flattenCategories(dat) {
  const flat = [];
  const walk = (items) => {
    for (const item of items || []) {
      flat.push({ id: item.id, name: item.name });
      walk(item.children);
    }
  };
  walk(listOf(dat));
  return flat;
}

// 规则的查询可能在 prom_ql，也可能在多条件的 multi_prom_ql 里。
function ruleQueries(rule) {
  const queries = [rule.prom_ql];
  for (const item of rule.multi_prom_ql || []) queries.push(typeof item === 'string' ? item : item && item.prom_ql);
  return queries.filter(Boolean);
}

function matchRules(rules, metricPattern) {
  const pattern = new RegExp(metricPattern);
  return rules.filter((rule) => ruleQueries(rule).some((query) => pattern.test(query)));
}

function buildRuleBody(template, overrides, gid, cid) {
  const missing = REQUIRED_RULE_FIELDS.filter((field) => !String(overrides[field] || '').trim());
  if (missing.length) throw new Error(`规则文件缺少必填字段：${missing.join(', ')}`);
  const body = { ...(template || {}) };
  for (const field of TEMPLATE_DROP_FIELDS) delete body[field];
  Object.assign(body, overrides, { group_id: Number(gid), category_id: Number(cid) });
  return body;
}

async function listRules(request, gid, cid) {
  const categories = cid
    ? [{ id: Number(cid), name: '' }]
    : flattenCategories((await request('GET', `/api/n9e/busi-groups/${gid}/categories`)).json.dat);
  const rules = [];
  for (const category of categories) {
    const response = await request('GET', `/api/n9e/busi-group/${gid}/category/${category.id}/alert-rules`);
    for (const rule of listOf(response.json.dat)) rules.push({ ...rule, category_id: category.id, category_name: rule.category_name || category.name });
  }
  return rules;
}

function summary(rule) {
  return {
    id: rule.id, name: rule.name, group_id: rule.group_id, category: rule.category_name, disabled: rule.disabled,
    severity: rule.severity, prom_ql: rule.prom_ql, prom_for_duration: rule.prom_for_duration,
    prom_eval_interval: rule.prom_eval_interval, notify_channels: rule.notify_channels, notify_groups: rule.notify_groups,
  };
}

async function runList(request, args) {
  if (!args.metric) throw new Error('list 需要 --metric <指标名或正则>');
  const gids = String(args.gid || '').split(',').filter(Boolean);
  if (!gids.length) {
    gids.push(...listOf((await request('GET', '/api/n9e/busi-groups?limit=1000')).json.dat).map((group) => String(group.id)));
  }
  let scanned = 0;
  const hits = [];
  for (const gid of gids) {
    const rules = await listRules(request, gid, args.cid);
    scanned += rules.length;
    hits.push(...matchRules(rules, args.metric).map((rule) => ({ ...summary(rule), group_id: Number(gid) })));
  }
  return { action: 'list', metric: args.metric, groups: gids.map(Number), scanned_rules: scanned, hits };
}

async function runCreate(request, args) {
  if (!args.gid || !args.cid || !args['rule-file']) throw new Error('create 需要 --gid --cid --rule-file');
  const overrides = JSON.parse(fs.readFileSync(args['rule-file'], 'utf8'));
  const template = args['template-rule']
    ? (await request('GET', `/api/n9e/alert-rule/${args['template-rule']}`)).json.dat
    : null;
  const body = buildRuleBody(template, overrides, args.gid, args.cid);
  const existing = (await listRules(request, args.gid, args.cid)).filter((rule) => rule.name === body.name);
  if (existing.length) return { action: 'create', outcome: 'exists', existing: existing.map(summary) };
  if (!args.apply) return { action: 'create', outcome: 'dry-run', body };
  const created = await request('POST', `/api/n9e/busi-group/${args.gid}/category/${args.cid}/alert-rules`, [body]);
  const failed = created.json.dat && created.json.dat.failed;
  if (failed && Object.keys(failed).length) return { action: 'create', outcome: 'failed', failed };
  const readback = (await listRules(request, args.gid, args.cid)).filter((rule) => rule.name === body.name);
  if (readback.length !== 1) return { action: 'create', outcome: 'readback-mismatch', count: readback.length };
  const detail = (await request('GET', `/api/n9e/alert-rule/${readback[0].id}`)).json.dat;
  const mismatched = ['name', 'prom_ql', 'severity', 'disabled', 'category_id'].filter((field) => String(detail[field]) !== String(body[field]));
  return { action: 'create', outcome: mismatched.length ? 'readback-mismatch' : 'created', mismatched, rule: summary(detail) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = process.argv[2];
  if (!['list', 'create'].includes(action)) throw new Error('用法：healthy_alert_rules.js list|create [选项]');
  const result = await withHealthyClient(args, ({ request }) => (action === 'list' ? runList(request, args) : runCreate(request, args)));
  console.log(JSON.stringify(result, null, 2));
  if (['failed', 'readback-mismatch'].includes(result.outcome)) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { buildRuleBody, flattenCategories, matchRules, ruleQueries, runCreate, runList };
