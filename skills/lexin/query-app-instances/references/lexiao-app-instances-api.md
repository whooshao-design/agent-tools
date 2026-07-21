# Lexiao App Instances API

Use these read-only Lexiao endpoints from a logged-in browser context. Do not paste or store cookies; run requests with `credentials: "include"` inside Playwright.

## App Lookup

`POST https://lexiao-api.oa.fenqile.com/oa/publish/application/list_simple_app.json`

Important request fields:

```json
{
  "page": 1,
  "app_type": "",
  "owner_or_manager": "",
  "name": "server-hawk-decision-executor-simulate",
  "privatization": ""
}
```

Observed behavior:

- `name` searches app names and returns `result_rows`.
- `project_name` can be used for exact project-name lookup such as `server_hawk_decision_executor_simulate`.
- `app_id` is an exact numeric app id filter. Do not use `app_id` for text search.
- `app_name` and `keyword` did not filter results in validation.
- `fid`, `id`, and `app_id` are the same app identifier for the validated Java apps.

`POST https://lexiao-api.oa.fenqile.com/oa/publish/application/get.json`

Body:

```json
{"id": "5286"}
```

Use this when the user already supplied `--app-id`.

## Machine Page

`https://lexiao.oa.fenqile.com/#/editApp?app_id=<fid>&type=machine`

The page exposes environment tabs and both VM and container lists. Prefer API responses below over scraping table text.

## Environments

`POST https://lexiao-api.oa.fenqile.com/oa/publish/appmachine/listAppMachineEnvs.json`

Body:

```json
{"app_id": "5286"}
```

Returns `result_rows` like:

```json
[
  {"cnt": 2, "env": "stable"},
  {"cnt": 2, "env": "pre"},
  {"cnt": 1, "env": "oa"},
  {"cnt": 2, "env": "gray"},
  {"cnt": 17, "env": "prod"}
]
```

## VM / KVM Instances

`POST https://lexiao-api.oa.fenqile.com/oa/publish/appMachine/getAppMachineDistinct.json`

Body:

```json
{
  "limit": 100,
  "page": 1,
  "env": "pre",
  "ip": "",
  "deployment_id": "",
  "app_id": "5286"
}
```

Useful fields:

- `ip`
- `env`
- `belong_set`
- `belong_set_cn`
- `biz_line`
- `run_status`
- `target_status`
- `app_version`
- `enable`
- `bind_type`

Loop pages until `page >= total_page` or fewer than `limit` rows are returned.

## Container / Pod Instances

`GET https://lexiao-api.oa.fenqile.com/oa/publish/devops/pod/getAppPodInfo.json?limit=100&page=1&env=pre&ip=&deployment_id=&app_id=5286`

Useful fields:

- `pod_name`
- `pod_ip`
- `host_ip`
- `env`
- `set`
- `pod_status`
- `version`
- `namespace`
- `deployment_id`
- `cluster_id`
- `login_pod_addr`
- `cpu_limit`
- `memory_limit`

`login_pod_addr` is the authoritative WebShell URL. Use it verbatim after validating the allowed host and, for the canonical URL form, `ns/pod/container/cluster/command` against the Pod row. The observed API contract does not guarantee a separate `container` field, so do not synthesize a URL by assuming that the application name is also the container name. Legacy URLs with an opaque `arg` may be passed through with an explicit unverifiable warning.

Loop pages until `total_page` is exhausted when present, otherwise until fewer than `limit` rows are returned.

## JDK Enrichment

`POST https://lexiao-api.oa.fenqile.com/oa/publish/appops/get_app_jdkversion.json`

Body:

```json
{"app_name": "server-hawk-decision-executor-simulate"}
```

Returns `ip`, `env`, and `jdk_version`. Use this to enrich VM rows when the main VM API does not expose JDK.

## Environment Aliases

- `pre`, `预发布` -> `pre`
- `prod`, `online`, `线上`, `生产` -> `prod`
- `gray`, `灰度` -> `gray`
- `oa` -> `oa`
- `stable`, `test`, `稳定`, `测试` -> `stable`
- `all`, `全部`, `*` -> all returned environments
