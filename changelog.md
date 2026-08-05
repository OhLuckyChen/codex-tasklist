# Changelog

## 2026-08-05 — Codex 重启后自动恢复任务面板

### 处理目标

- 电脑重启并登录后，用户正常打开 Codex，任务面板入口能够自动出现。
- Codex 关闭后再次打开，任务面板入口能够自动恢复。
- 保留已有 SQLite 任务数据，不修改 Codex 客户端文件。

### 已完成

- 新增 macOS 常驻监督器 `scripts/codex-taskboard-supervisor.sh`。
- 监督器在 Codex 未运行时保持等待，不会因为登录自启而主动打开 Codex。
- 检测到普通方式启动、未启用 CDP 的 Codex 后，监督器会执行一次受控重启，并使用仅监听本机的 CDP 端口重新启动。
- Codex 已使用 CDP 启动时，监督器会自动连接并注入任务面板入口。
- Codex 关闭后，监督器返回等待状态；下一次打开时重新执行相同恢复链路。
- 修复常驻注入器在 CDP 端口消失后仍无限等待的问题。现在 CDP 关闭时注入器会退出，由监督器接管下一轮启动。
- 将 Codex 进程识别从不稳定的进程短名称匹配改为完整可执行路径匹配。
- 安装并启用登录自启项 `com.lincya.codex-taskboard.supervisor`，配置为 `RunAtLoad` 和 `KeepAlive`。
- 卸载旧的单次重启任务 `com.lincya.codex-taskboard.restart.once`。
- 安装时保留当前正在使用的 Codex 会话；自动接管从下一次关闭并重新打开 Codex 开始生效。

### 数据边界

- 任务数据仍保存在 `.data/taskboard.sqlite`。
- 登录自启配置位于 `~/Library/LaunchAgents/com.lincya.codex-taskboard.supervisor.plist`。
- 未修改、替换或重新签名 Codex 应用。
- CDP 仅监听 `127.0.0.1:9229`。

### 验证结果

- LaunchAgent 配置通过 `plutil -lint`。
- LaunchAgent 已加载，状态为 `running`，并确认包含 `runatload` 与 `keepalive`。
- 旧的 `restart.once` 任务已不存在。
- 监督器脚本通过 `zsh -n` 语法检查。
- 注入器通过 `node --check` 语法检查。
- 注入器相关定向测试共 13 项，全部通过。
- 全量测试仍存在与本次启动链路无关的既有失败，包括 AI Chat 导出、附件和云代理相关断言；本次未修改这些模块。

### 运行说明

首次安装不会中断正在进行的 Codex 会话。关闭当前 Codex 后，下一次从 Dock、访达或其他普通入口打开 Codex，监督器会自动完成一次 CDP 重启和任务面板注入。后续每次关闭、重新打开以及电脑重启后的首次打开均走同一链路。
