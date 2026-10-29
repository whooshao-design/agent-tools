'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizeResponses, parseDetailDialog, pickPublishCluster, classifyConfirm, classifyPublishProgress, detailsUrl,
} = require('../scripts/lexiao_project_env');

const APP = 'server_hawk_decision_task';
const CLUSTER = 'stable-lexin-sz-glbd-cilium-phy-cluster-01';
const CLUSTER_HEADERS = ['', '发布状态', '应用名', '集群set', '集群', '逻辑机房', '副本数', '实例发布进度', '发布时间', '操作', ''];
const POD_HEADERS = ['序号', '实例名称', '容器ip', '版本号', '运行状态', '存活周期', '操作'];

function clusterRow(status, set = 'gz_ydjd_idc', cluster = CLUSTER, buttons = []) {
  return { cells: ['', status, APP, set, cluster, '深圳观澜宝德机房', '1', '', '', '', ''], buttons };
}

// 结构取自 2026-10-28 需求 53704 弹窗：集群表 + 嵌套 Pod 表（Pod 表出现两次时去重）。
function dialog(rows, text = `${APP} 项目环境 3.67.2 java 容器化发布进度（pod副本数） 已发布机器数：(0/1) 已回滚机器数：(0/1)`) {
  const pod = { cells: ['1', 'server-hawk-decision-task-1426731-abc', '10.9.91.37', '3.67.2', 'FAILED', '5秒', '登录实例 启动日志'], buttons: [] };
  return { text, tables: [
    { headers: CLUSTER_HEADERS, rows },
    { headers: ['CPU（核数）', '内存（GB）'], rows: [] },
    { headers: POD_HEADERS, rows: [pod] },
    { headers: POD_HEADERS, rows: [pod] },
  ] };
}

const publishButton = [{ text: '发布', disabled: false }];

test('dialog parsing reports version, counters, cluster rows and deduplicated pods', () => {
  const parsed = parseDetailDialog(dialog([clusterRow('待发布', undefined, undefined, publishButton)]));
  assert.equal(parsed.version_tag, '3.67.2');
  assert.deepEqual(parsed.published, { done: 0, total: 1 });
  assert.equal(parsed.clusters.length, 1);
  assert.equal(parsed.clusters[0].status, '待发布');
  assert.equal(parsed.clusters[0].set, 'gz_ydjd_idc');
  assert.equal(parsed.clusters[0].cluster, CLUSTER);
  assert.equal(parsed.pods.length, 1);
  assert.equal(parsed.pods[0].state, 'FAILED');
  assert.equal(parsed.deployable, true);
  assert.equal(parseDetailDialog(dialog([clusterRow('已发布')])).deployable, false);
  assert.equal(parseDetailDialog(null), null);
});

test('cluster pick needs exactly one 待发布 row with an enabled 发布 button', () => {
  const one = [clusterRow('已发布', 'a', 'c1'), clusterRow('待发布', 'b', 'c2', publishButton)];
  const clusters = parseDetailDialog(dialog(one)).clusters;
  assert.equal(pickPublishCluster(clusters, '').target.cluster, 'c2');

  const two = parseDetailDialog(dialog([clusterRow('待发布', 'a', 'c1', publishButton), clusterRow('待发布', 'b', 'c2', publishButton)])).clusters;
  assert.equal(pickPublishCluster(two, '').error, 'cluster-ambiguous');
  assert.equal(pickPublishCluster(two, 'c1').target.set, 'a');
  assert.equal(pickPublishCluster(two, 'b').target.cluster, 'c2');
  assert.equal(pickPublishCluster(two, 'c9').error, 'cluster-not-found');

  assert.equal(pickPublishCluster(parseDetailDialog(dialog([clusterRow('已发布')])).clusters, '').error, 'no-pending-cluster');
  const disabled = parseDetailDialog(dialog([clusterRow('待发布', 'a', 'c1', [{ text: '发布', disabled: true }])])).clusters;
  assert.equal(pickPublishCluster(disabled, '').error, 'publish-button-unavailable');
  const rollbackOnly = parseDetailDialog(dialog([clusterRow('待发布', 'a', 'c1', [{ text: '回滚', disabled: false }])])).clusters;
  assert.equal(pickPublishCluster(rollbackOnly, '').error, 'publish-button-unavailable');
});

test('confirm boxes: only plain publish/deploy confirmations are accepted', () => {
  assert.equal(classifyConfirm('确认发布该集群吗？ 取消 确定'), 'confirm');
  assert.equal(classifyConfirm('请确认是否进行一键部署操作?'), 'confirm');
  assert.equal(classifyConfirm('确认回滚到上一版本？'), 'reject');
  assert.equal(classifyConfirm('确认执行灰度发布'), 'reject');
  assert.equal(classifyConfirm('确认批量推送？'), 'reject');
  assert.equal(classifyConfirm('是否继续？'), 'unknown');
});

const detail = (desc, status) => ({ deployment_order_detail_list: [{
  set: 'gz_ydjd_idc', cluster_id: CLUSTER, order_detail_id: 408855, version_tag: '3.67.2',
  publish_status_desc: desc, publish_status: status, publish_msg: desc,
}] });
const progress = (published, podStatus) => ({ total_replicas: 1, published_num: published, progress_list: [{
  order_detail_id: 408855, summary_status_desc: '', pod_info_list: [{ pod_name: 'p1', pod_ip: '1.1.1.1', version: '3.67.2', pod_status: podStatus }],
}] });
const target = { set: 'gz_ydjd_idc', cluster: CLUSTER };

test('publish progress: success needs 已发布 and all replicas; a FAILED pod mid-roll is still running', () => {
  assert.equal(classifyPublishProgress(detail('已发布', 'ROLL_INIT'), progress(1, 'RUNNING'), target).state, 'success');
  assert.equal(classifyPublishProgress(detail('发布中', 'PUBLISHING'), progress(0, 'FAILED'), target).state, 'running');
  assert.equal(classifyPublishProgress(detail('已发布', 'ROLL_INIT'), progress(0, 'RUNNING'), target).state, 'running');
  assert.equal(classifyPublishProgress(detail('发布失败', 'PUBLISH_FAIL'), progress(0, 'FAILED'), target).state, 'failed');
  assert.equal(classifyPublishProgress(detail('已回滚', 'ROLLED_BACK'), progress(0, 'RUNNING'), target).state, 'failed');
  assert.equal(classifyPublishProgress(null, null, target).state, 'running');
  const done = classifyPublishProgress(detail('已发布', 'ROLL_INIT'), progress(1, 'RUNNING'), target);
  assert.equal(done.pods[0].name, 'p1');
  assert.equal(done.order_detail_id, 408855);
});

test('order id prefers the order created when the dialog opened, demand id comes from page requests', () => {
  const base = 'https://lexiao-api.oa.fenqile.com';
  const responses = [
    { url: `${base}/oa/lexiao/version_publish_detail_list.json?demandId=1426731`, json: { result_rows: [] } },
    { url: `${base}/oa/lexiao/get_version_publish_status.json`, json: { result_rows: [
      { app_name: 'other', publish_order_id: 1 },
      { app_name: APP, publish_order_id: 2204050, need_show_deploy_red_dot: true, publish_status: 'PUBLISHED' },
    ] } },
    { url: `${base}/oa/lexiao/pipeline/create_publish_order.json`, json: { result_rows: [{ order_id: 2209999 }] } },
    { url: `${base}/oa/publish/devops/deploymentOrder/getPublishDetails.json?version_id=0&order_id=2209999&env=prj&app_type=java&demand_id=1426731`, json: {} },
  ];
  const summary = summarizeResponses(responses, APP);
  assert.equal(summary.order_id, 2209999);
  assert.equal(summary.demand_id, '1426731');
  assert.equal(summary.row_publish_status.publish_order_id, 2204050);
  assert.equal(summary.row_publish_status.need_show_deploy_red_dot, true);
  assert.equal(summarizeResponses(responses.slice(0, 2), APP).order_id, 2204050);
  assert.match(detailsUrl(2209999, '1426731'), /order_id=2209999&env=prj&app_type=java&demand_id=1426731$/);
});

// 结构取自 2026-10-28 需求 53704 项目环境表：四个应用共用 process-engine 前缀。
const {
  pickAppRow, branchOfRow, pickPipeline, classifyBuildConfirm, classifyBuild,
} = require('../scripts/lexiao_project_env');

const appRow = (name, t = 0, r = 0) => ({ t, r, cells: [name, `${name}-java`, '分期乐 GROUP: project_1092458', 'rel_processOwnerAlert_1426731 研发: joneyshao', '待合并', '执行成功'] });

test('app row is matched by an exact cell, not by prefix or by an enclosing row', () => {
  const rows = [
    { t: 0, r: 0, cells: ['process-engine-simulate process-engine process-engine-ec'] },
    appRow('process-engine-simulate', 1, 0), appRow('process-engine', 1, 1), appRow('process-engine-ec', 1, 2),
  ];
  assert.equal(pickAppRow(rows, 'process-engine').row.r, 1);
  assert.equal(pickAppRow(rows, 'process-engine-ec').row.r, 2);
  assert.equal(pickAppRow(rows, 'process-engine-batch').error, 'row-not-found');
  assert.equal(pickAppRow([...rows, appRow('process-engine', 2, 0)], 'process-engine').error, 'row-ambiguous');
});

test('pipeline is picked by the exact job name feature-pipeline-<app>-<branch>', () => {
  const branch = branchOfRow(appRow('process-engine'));
  assert.equal(branch, 'rel_processOwnerAlert_1426731');
  const job = (app, no) => `https://devops-jenkins.oa.fenqile.com/job/feature-pipeline-${app}-${branch}/${no}/`;
  const rows = [
    { pipeline_job_url: job('process-engine-ec', 2), pipeline_status_desc: '执行成功', artifact_status_list: [{ env: 'prj', artifact_status_desc: '制作成功' }] },
    { pipeline_job_url: job('process-engine', 8), pipeline_status_desc: '执行中', artifact_status_list: [{ env: 'pre', artifact_status_desc: '制作成功' }, { env: 'prj', artifact_status_desc: '制作中' }] },
  ];
  assert.deepEqual(pickPipeline(rows, 'process-engine', branch), {
    job_url: job('process-engine', 8), build_no: 8, pipeline_status_desc: '执行中', artifact_status_desc: '制作中',
  });
  assert.equal(pickPipeline(rows, 'process-engine-ec', branch).build_no, 2);
  assert.equal(pickPipeline(rows, 'process-engine-batch', branch), null);
});

test('build confirmation and progress classification', () => {
  assert.equal(classifyBuildConfirm('提示 请确认是否进行构建操作? 取消 确定'), 'confirm');
  assert.equal(classifyBuildConfirm('确认回滚后重新构建？'), 'reject');
  assert.equal(classifyBuildConfirm('是否继续？'), 'unknown');
  const before = { build_no: 2 };
  assert.equal(classifyBuild(before, { build_no: 2, pipeline_status_desc: '执行成功', artifact_status_desc: '制作成功' }), 'not-started');
  assert.equal(classifyBuild(before, { build_no: 3, pipeline_status_desc: '执行中', artifact_status_desc: '制作成功' }), 'running');
  assert.equal(classifyBuild(before, { build_no: 3, pipeline_status_desc: '执行成功', artifact_status_desc: '制作中' }), 'running');
  assert.equal(classifyBuild(before, { build_no: 3, pipeline_status_desc: '执行成功', artifact_status_desc: '制作成功' }), 'success');
  assert.equal(classifyBuild(before, { build_no: 3, pipeline_status_desc: '执行失败', artifact_status_desc: null }), 'failed');
  assert.equal(classifyBuild(before, null), 'unknown');
});
