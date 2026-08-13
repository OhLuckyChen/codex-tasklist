# Hermes Taskboard Data Flywheel

Taskboard does not own WeCom bot credentials or WeCom message transport.
Hermes owns the WeCom gateway, BotID, Secret, model provider, conversation
memory, and tool policy. Taskboard is the local MCP-backed data flywheel:
Hermes reads project context and writes back consultations, self-service
defects, knowledge candidates, and source citations.

## Runtime Boundary

- WeCom BotID and Secret are configured in Hermes or the Hermes WeCom gateway.
- Taskboard stores no WeCom BotID, Secret, callback token, callback URL, or
  WebSocket connection state.
- Hermes maps one bot to one local workspace path. It resolves the Taskboard
  project with `taskboard_resolve_project_by_workspace`.
- Hermes can answer from its own context and local source access. When it
  persists outcomes, it uses Taskboard MCP tools.

## Model Configuration

Use environment variables or a Hermes profile file. Do not commit secrets.

```bash
export ANTHROPIC_BASE_URL="https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic"
export ANTHROPIC_API_KEY="$TOKENPLAN_API_KEY"
export HERMES_MODEL="qwen3.8-max"
export TASKBOARD_MCP_URL="http://127.0.0.1:47823"
```

The API key value must stay in the local secret store, shell environment, or
Hermes private config. It must not be written to Taskboard project data,
knowledge proposals, comments, logs, or frontend state.

## MCP Tools For Hermes

- `taskboard_resolve_project_by_workspace`: find the project for a configured
  bot workspace.
- `taskboard_get_project_context`: read project metadata plus supported labels
  and citation source types.
- `taskboard_search_project_knowledge`: search project knowledge with sources.
- `taskboard_record_interaction`: persist a WeCom/Hermes question and answer.
  Labels are only `咨询` and `缺陷`.
- `taskboard_create_knowledge_candidate`: create a reviewable knowledge proposal
  from a consultation. It does not publish files.
- `taskboard_create_self_service_defect`: create a Taskboard issue with the
  existing `缺陷` label.
- `taskboard_link_sources`: attach or replace citations on a recorded
  interaction.

## Suggested Hermes Profile Instruction

```text
You are the project support agent for one configured workspace.

Use Taskboard MCP only as the project data flywheel:
1. Resolve the project from the configured workspace path before writing.
2. Prefer project knowledge search before answering stable business facts.
3. Cite knowledge, source files, or Taskboard issues for implementation,
   call-chain, and troubleshooting answers.
4. After answering, record the interaction with label 咨询 or 缺陷.
5. When the exchange reveals durable knowledge, create a knowledge candidate.
6. When the exchange reveals a reproducible self-service defect, create a
   defect issue with label 缺陷.
7. Do not write WeCom credentials to Taskboard.
8. Do not perform code modification, Git, deployment, database writes, or other
   side effects unless the user explicitly escalates into a coding workflow.
```

