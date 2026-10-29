'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findPipelineForApp } = require('../scripts/lexiao_pre_release');

const job = (name, no = 1) => `https://devops-jenkins.oa.fenqile.com/job/integration-pipeline-${name}-rel_processOwnerAlert_1426731/${no}/`;

// 行结构取自 2026-10-29 需求 53704 的 ci_pipeline_status_batch：行里没有 app_name，只能靠 job URL 认应用。
const console = { app_id: 4983, pipeline_job_url: job('process-engine-console-java') };
const engine = { app_id: 4998, pipeline_job_url: job('process-engine') };
const notBuilt = { app_id: 5023, pipeline_status: -1 };

test('prefix app name does not match a longer app pipeline listed first', () => {
  assert.equal(findPipelineForApp([console, engine], 'process-engine'), engine);
  assert.equal(findPipelineForApp([console, notBuilt], 'process-engine'), null);
});

test('exact job name wins and underscore/hyphen differences are ignored', () => {
  assert.equal(findPipelineForApp([engine, console], 'process-engine-console-java'), console);
  const hawk = { app_id: 3014, pipeline_job_url: job('server_hawk_decision_manage', 2) };
  assert.equal(findPipelineForApp([hawk], 'server-hawk-decision-manage'), hawk);
});

test('substring fallback is used only when it is unique', () => {
  const custom = { app_id: 1, pipeline_job_url: 'https://jenkins/job/custom-build-process-engine-ec/3/' };
  assert.equal(findPipelineForApp([custom], 'process-engine-ec'), custom);
  const other = { app_id: 2, pipeline_job_url: 'https://jenkins/job/other-process-engine-ec-x/1/' };
  assert.equal(findPipelineForApp([custom, other], 'process-engine-ec'), null);
});
