# mdview

本地 Markdown/HTML 查看器：本机 http 服务 + 浏览器渲染（离线 mermaid、代码高亮、复制为富文本、文件改动自动刷新），并支持对文档留评论给 agent 处理。

## 运行

```bash
mdview [文件或目录] [-p 端口] [--no-open] [--new] [--idle 分钟]
```

- `~/.local/bin/mdview` 是指向 `tools/mdview/mdview` 的符号链接。
- 常驻方式：`systemd/mdview.socket` 监听 `127.0.0.1:8321`，访问时按需拉起 `systemd/mdview.service`（根目录 `~/docs`，空闲 30 分钟退出）。修改单元后复制到 `~/.config/systemd/user/`，再 `systemctl --user daemon-reload && systemctl --user stop mdview.service`，下次访问即用新代码。
- `vendor/` 是离线依赖：marked 15.0.12、highlight.js 11.12.0、mermaid 11.17.0。

## 评论

在页面上选中正文文字，点「💬 评论」写意见，Ctrl+Enter 保存；右侧评论栏列出未处理和已处理的评论，点条目可定位原文。评论不写进文档，存在 `${XDG_STATE_HOME:-~/.local/state}/mdview/comments/<路径哈希>.json`，按文件真实路径区分。

agent 读写评论：

```bash
mdview comments <文件>                                   # 未处理评论（JSON，含原文 quote、所在标题、源文件大致行号 line）
mdview comments <文件> --all                             # 含已处理
mdview comments <文件> --resolve <id> --reply "怎么改的"  # 标记已处理并回复，页面约 5 秒内刷新
mdview comments <文件> --reopen <id>
```

`line` 由渲染文字反查源文件，找不到时为 `null`，页面会标「原文已改动」。HTML 文件不支持评论。

## 测试

```bash
node --test tools/mdview/tests/*.test.mjs
```
