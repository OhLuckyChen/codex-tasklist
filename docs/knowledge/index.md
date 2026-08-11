---
id: project.index
title: e-taskboard 项目知识
kind: index
updated_at: 2026-08-11
sources:
  - type: file
    ref: README.md
    revision: git-blob:530ecea0c57ee25828e0f5ac0321bfe5ce2e8fe9
  - type: file
    ref: package.json
    revision: git-blob:1cd0a10a297e9ee3d27c4b6ad3e03575eeecc794
---
# e-taskboard 项目知识

这里保存已经确认、能够从当前代码或项目文档中验证的长期知识。讨论中的方案、未完成结论和待确认内容保留在 Taskboard 知识提案中，不进入这些页面。

## 导航

- [项目概览](project-overview.md)：目标、用户、主要能力与运行方式。
- [系统架构](architecture.md)：本地服务、Web、Agent runtime 与 Codex 宿主之间的边界。
- [代码地图](code-map.md)：主要入口、模块职责和修改起点。
- [关键流程](key-flows.md)：议题协作、会话关联、知识沉淀和本地同步链路。
- [工程说明](engineering-notes.md)：开发、验证、安全边界和常见注意事项。
- [项目持续知识中心](designs/project-knowledge-center.md)：已实现知识中心的技术方案。

## 使用约定

正式知识按主题维护，事实变化时更新原页面，不按日期堆叠副本。真实项目变化写入根目录 `changelog.md`；已落地技术方案进入 `designs/`。每页 `sources` 记录来源及其版本，健康检查会据此判断内容是否需要复核。
