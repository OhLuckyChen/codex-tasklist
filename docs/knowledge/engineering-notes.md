---
id: project.engineering-notes
title: 工程说明
kind: engineering
updated_at: 2026-08-10
sources:
  - type: file
    ref: package.json
    revision: git-blob:30dd4173c74cd24b4903959f635320078216fa7b
  - type: file
    ref: server/app.mjs
    revision: git-blob:486a789c064e548df3ed1ce42b38b5229a03086a
  - type: file
    ref: cloud/src/index.mjs
    revision: git-blob:a64ec39efc97bff4c374b3ca0e4af6751b61200d
---
# 工程说明

## 开发与验证

- Node.js 最低版本为 22.5。
- `npm run typecheck` 检查 Web TypeScript。
- `npm run build:web` 只构建 Web；`npm run build` 还会在任务面板正在运行时刷新嵌入页面。
- `npm test` 执行本地服务、云端 Worker、CLI、注入器和静态交互测试。
- `npm run check` 依次执行类型检查、生产构建和完整测试。

## 实现约束

- 本地和云端有两套业务持久化实现；新增可同步实体时必须同时补 SQLite schema、D1 migration、两端路由和测试。
- 云端不能持久化设备绝对路径。worktree 提案只保存类型与分支，实际路径在发布设备上重新解析。
- 用户输入先经过允许字段、长度、枚举和路径校验；大体积知识提案使用单独的 6 MiB 请求上限。
- 不覆盖或回滚工作区中的其他改动。知识发布只写审核提案列出的允许文件。

## 常见注意事项

- `npm run build` 可能刷新正在运行的 Codex 内嵌 iframe，但不会重启 Codex 主进程。
- Worker 测试中的故意 D1 约束错误会打印错误堆栈；对应补偿测试通过时属于预期输出。
- 正式知识中的来源版本是工作区当前内容的 Git blob，而不是最近提交版本，因此未提交但已确认的实现也能被准确检查。
- 问答会同时读取正式知识与当前代码；涉及当前行为时以代码证据为准，并返回引用。
