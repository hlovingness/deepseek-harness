---
description: "SDK profile 的 Cordis 插件：将 Host 的 agent/assistant-stream 帧镜像为瞬时 assistant/live-chunk 的 session.event 通知，供进程外桌面／原生客户端使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sdk-assistant-stream-bridge

[English](README.md) | 中文

## 摘要

`dsh-sdk-assistant-stream-bridge` 挂在 `sdk` profile 中、位于 `@deepseek-ai/dsh-sdk-jsonrpc-server` 之后。它注入 `sdkJsonRpc`，声明 `assistant/live-chunk` capability，监听 Host `agent/assistant-stream` 与 durable `session/event` 序号，并向客户端 `notify('session.event', …)` 推送 `type: 'assistant/live-chunk'` 的瞬时信封（含 text-delta / reasoning-delta）。Live chunk **不**写入 durable session log——与 Web 端 `ClientAssistantStream` 的折叠语义一致。

## 目录

- [使用本包](#use-this-package)
- [进一步探索](#further-exploration)

-----

<a id="use-this-package"></a>
## 使用本包

通过 sdk-app bundle patch（`sdk-assistant-stream-bridge`）挂载，使桌面／原生客户端能在 stdio 上收到真·流式增量。桌面 `ConversationStore` 已消费 `assistant/live-chunk`。

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-sdk-jsonrpc-server`](../server/README.zh.md) — 扩展面（`sdkJsonRpc`）
- [`dsh-sdk-approval-bridge`](../approval-bridge/README.zh.md) — 同款兄弟插件模式
- Web `ClientAssistantStream` — 浏览器侧对 `assistant-stream` follow 帧的折叠
