#!/usr/bin/env node
// 上游 @larksuiteoapi/lark-mcp 的缺陷补丁。
//
// 每条补丁必须唯一命中一次，否则整体失败：
//   命中 0 次 = 上游代码已变，需人工复核；命中 >1 次 = 锚点不够特异。
// 失败即非零退出，由 bin/lark-mcp 拒绝以未修复状态启动；逃生口是 LARK_MCP_SKIP_PATCH=1。
//
// 幂等：每个文件打完补丁后带 MARKER 注释；已含 MARKER 则跳过。
// 全部成功后写 .patch-stamp（内容 = 包名 + 本脚本 sha256），install 时由 wrapper 删除。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const MARKER = "[agent-tools patch]";
const installRoot = process.argv[2];
if (!installRoot) {
  console.error("用法: apply.mjs <INSTALL_ROOT>");
  process.exit(1);
}
const dist = join(installRoot, "node_modules/@larksuiteoapi/lark-mcp/dist");

// P0-1: descendants[] 元素 schema 漏了 block_id / children。
// zod 默认 strip 会把它们丢掉，导致 children_id 引用不到任何块 -> 1770041 open schema mismatch。
// 代码生成器把扁平 children[] 的块 schema 原样复用给了嵌套接口，所以两个字段从来没生成过。
const DESCENDANT_FIX = `
// ${MARKER} upstream lark-mcp: descendants[] 漏了 block_id / children
{
  const t = exports.docxV1DocumentBlockDescendantCreate;
  const el = t.schema.data.shape.descendants._def.element;
  t.schema.data = zod_1.z.object({
    ...t.schema.data.shape,
    descendants: zod_1.z
      .array(
        el.extend({
          block_id: zod_1.z.string().describe('临时 BlockID，供 children_id / children 引用').optional(),
          children: zod_1.z.array(zod_1.z.string()).describe('子块的临时 BlockID 列表').optional(),
        }),
      )
      .describe('添加的子孙列表，包括孩子'),
  });
}
`;

// P0-2: OAuth 本地服务器被写死 60 秒后关闭，且与 handleLogin 的 timeout 选项无关。
// 结果是任何超过 60 秒的人工授权必然失败：端口已关，进程还在空转到 timeout。
const PATCHES = [
  {
    file: "auth/handler/handler-local.js",
    find: "this.timeoutId = setTimeout(() => this.stopServer(), 60 * 1000);",
    replace:
      `// ${MARKER} 原为写死的 60 * 1000\n` +
      "            this.timeoutId = setTimeout(() => this.stopServer(), Number(process.env.LARK_OAUTH_WINDOW_MS) || 60 * 1000);",
  },
  {
    file: "cli/login-handler.js",
    find: "const { appId, appSecret, domain, host, port, scope, timeout = 60000 } = options;",
    replace:
      `// ${MARKER} 原为写死的 timeout = 60000\n` +
      "        const { appId, appSecret, domain, host, port, scope, timeout = Number(process.env.LARK_OAUTH_WINDOW_MS) || 60000 } = options;",
  },
  {
    // keytar 走 libsecret / gnome-keyring。钥匙串处于 Locked 状态时它会等一个
    // 永远不会出现的解锁弹窗（无 GUI 的 WSL/容器里必然如此），于是无限期挂起。
    // 上游本来有降级路径（storage-manager.js:66-70 catch 后退回内存存储），
    // 但那是 catch，挂起不会触发它。加超时把「挂死」变成「响亮失败」。
    // 上游用 keytar 把 AES key 存进 OS 钥匙串。无头环境（WSL / 容器 / CI）里
    // gnome-keyring 没有可用的默认 collection 时，setPassword 会等一个永不出现的
    // 解锁弹窗而无限阻塞（已实测：getPassword 12ms 返回 null，setPassword 永不返回）。
    //
    // 本补丁只做「快速失败」：给两个 keytar 调用加超时，避免无限挂起。
    // 注意它不能让无头环境恢复可用——上游 catch 后只把 isInitializedStorageSuccess
    // 置 false，随后 getAllLocalAccessTokens 会抛「未初始化」。要真正在无头环境使用，
    // 需要解锁/创建默认钥匙串，或让上游支持非钥匙串的密钥来源（未实现，见审计报告）。
    file: "auth/utils/storage-manager.js",
    find:
      "            let key = await keytar.getPassword(config_1.AUTH_CONFIG.SERVER_NAME, config_1.AUTH_CONFIG.AES_KEY_NAME);\n" +
      "            if (!key) {\n" +
      "                key = encryption_1.EncryptionUtil.generateKey();\n" +
      "                await keytar.setPassword(config_1.AUTH_CONFIG.SERVER_NAME, config_1.AUTH_CONFIG.AES_KEY_NAME, key);\n" +
      "            }",
    replace:
      `            // ${MARKER} keytar 在钥匙串锁定时会永久阻塞，加超时让上游的 catch 能生效\n` +
      "            const __withTimeout = (p) => Promise.race([p, new Promise((_, reject) => setTimeout(\n" +
      "                () => reject(new Error('keytar timeout: OS 钥匙串无响应（常见原因是 gnome-keyring 处于 Locked 状态）。'\n" +
      "                    + '解锁钥匙串后重试，或设 LARK_KEYTAR_TIMEOUT_MS 调整超时。')),\n" +
      "                Number(process.env.LARK_KEYTAR_TIMEOUT_MS) || 5000))]);\n" +
      "            let key = await __withTimeout(keytar.getPassword(config_1.AUTH_CONFIG.SERVER_NAME, config_1.AUTH_CONFIG.AES_KEY_NAME));\n" +
      "            if (!key) {\n" +
      "                key = encryption_1.EncryptionUtil.generateKey();\n" +
      "                await __withTimeout(keytar.setPassword(config_1.AUTH_CONFIG.SERVER_NAME, config_1.AUTH_CONFIG.AES_KEY_NAME, key));\n" +
      "            }",
  },
  { file: "mcp-tool/tools/zh/gen-tools/zod/docx_v1.js", append: DESCENDANT_FIX },
  { file: "mcp-tool/tools/en/gen-tools/zod/docx_v1.js", append: DESCENDANT_FIX },
];

const selfHash = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
const stampFile = join(installRoot, ".patch-stamp");
const stamp = `${dist}\n${selfHash}\n`;
if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) process.exit(0);

let applied = 0;
for (const p of PATCHES) {
  const path = join(dist, p.file);
  if (!existsSync(path)) {
    console.error(`补丁目标不存在: ${p.file}`);
    process.exit(1);
  }
  let src = readFileSync(path, "utf8");
  if (src.includes(MARKER)) continue; // 已打过

  if (p.append) {
    src += p.append;
  } else {
    const hits = src.split(p.find).length - 1;
    if (hits !== 1) {
      console.error(`补丁锚点在 ${p.file} 命中 ${hits} 次（期望 1 次），上游代码可能已变更`);
      process.exit(1);
    }
    src = src.replace(p.find, p.replace);
  }
  writeFileSync(path, src);
  applied++;
}

writeFileSync(stampFile, stamp);
if (applied > 0) console.error(`已应用 ${applied} 处 lark-mcp 上游补丁`);
