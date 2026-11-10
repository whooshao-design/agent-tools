# Lexiao app row fields and script output

## `POST https://lexiao-api.oa.fenqile.com/oa/publish/application/list_simple_app.json`

Same endpoint as `query-app-instances` (request body and search semantics are documented in
`$AGENT_TOOLS_ROOT/skills/lexin/query-app-instances/references/lexiao-app-instances-api.md`). `result_rows[]`
fields the script copies into `candidates[]` (validated 2026-11-10 with `app_id=584`):

| Field | Meaning | Example |
|---|---|---|
| `fid` / `id` / `app_id` | the same app identifier; emitted as `app_id` | `584` |
| `name` / `app_name` | runtime application name (`application.name`) | `server_credit_api` |
| `project_name` | repository/project name as registered in Lexiao, exact-match filter | `server-credit-api-java` |
| `group_name` | GitLab group | `credit_platform` |
| `git_addr` | clone URL registered in Lexiao, usually `http://gitlab.fenqile.com/<group>/<project>.git` | |
| `pom_path` | path of the build file inside the repository | `pom.xml` |
| `interface_prefix` | Dubbo interface package prefix | `com.fenqile.rc.credit.api` |
| `owner` | application owner | login name |
| `manager` | `;`-separated manager login names | |
| `app_type` | `java`, `node`, ... | |
| `jdk` | JDK label used by Lexiao builds | `jdk_18` |
| `port` | service port | |
| `biz_line` | business line label | |

Search behaviour: `project_name` is exact, `name` is fuzzy, `app_id` is an exact numeric filter (a numeric string
works); `app_name` and `keyword` do not filter. The script searches `project_name` then `name` for the given value and
its `_`→`-` and `-`→`_` spellings, de-duplicates by `fid`, then ranks exactly like `query_app_instances.resolveApp`:
exact `name`/`app_name` → exact `project_name` → equal after removing `-`/`_`/spaces → substring.

## Script output (`--json`)

| Key | Content |
|---|---|
| `candidates[]` | ranked Lexiao rows reduced to the fields above (or one synthetic row for `--repo`) |
| `lexiao` | `searched` row count and the session used (`profile`, `network_policy`, `session_source` = `cache`/`browser`) |
| `repo` | `git_addr`, `clone_url` (after `--protocol`), `web_url` (for requesting access), `name`, `group` |
| `local_clones[]` | existing clones under the workspace with the same host + project path (`path`, `remote`) |
| `suggested_parent_dirs[]` | `{dir, count}` parent directories (relative to the workspace root) of clones from the same group |
| `access` | lookup mode only: `git ls-remote --exit-code <url> HEAD` result, `access` ∈ `ok`/`no_access`/`no_credential`/`network`/`timeout`/`error`; exit 2 with empty stderr (empty repository) counts as `ok` |
| `stale_temp_dirs[]` | clone mode only: `.clone-app-repo-*` directories left in the parent by interrupted runs; reported, never deleted |
| `clone` | clone mode only: `status` (`cloned`/`target_exists`/`timeout`/git failure class), `target`, `branch`, `command`, `detail` (last 1500 chars of git stderr) |
| `status` | `lookup` / `exists` / `cloned` / `ambiguous` / `not_found` / `no_access` / `no_credential` / `network` / `timeout` / `error` (`target_exists` is reported as `error` with `clone.status=target_exists`) |
| `next_step` | one-line instruction for the agent |

## git stderr classification

| `status` | Matched text (regex, case-insensitive) | Typical cause |
|---|---|---|
| `no_credential` | `could not read Username`, `terminal prompts disabled`, `Permission denied (publickey`, `Authentication failed`, `HTTP 401`, `returned error: 401`, `invalid username or password` | no stored credential for the host, or the stored one was rejected |
| `no_access` | `could not be found or you don't have permission`, `You are not allowed to`, `HTTP 403`, `returned error: 403/404`, `repository '...' not found`, `Project ... not found` | no project permission, or the project does not exist (GitLab hides both behind the same message) |
| `network` | `Could not resolve host`, `Connection refused/timed out`, `Network is unreachable`, `Failed to connect`, `Recv failure`, `kex_exchange_identification`, `Connection closed by remote host`, `SSL_connect`, `SSL certificate problem`, `Timed out` | VPN/aTrust down, proxy, certificate, ssh port closed |
| `timeout` | git killed after `--timeout` ms (spawn error `ETIMEDOUT`) | slow or very large clone |
| `error` | anything else (HTTP 5xx, local path errors, ...) | inspect `detail` |

Exit codes: `0` ok (`lookup`/`exists`/`cloned`), `1` error (bad arguments, `ambiguous` with `--dir`, `target_exists`, `timeout`, other git failures),
`2` agent-tools root not found (bootstrap) or Playwright runtime missing (raised by `query_app_instances.js` on load), `3` `no_access`, `4` `no_credential`, `5` `network`, `6` `not_found`.
