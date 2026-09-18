---
description: "SDK-profile Cordis plugin that mirrors Host agent/assistant-stream frames as transient assistant/live-chunk session.event notifications for out-of-process desktop/native clients."
kind: "package-reference"
---

# @deepseek-ai/dsh-sdk-assistant-stream-bridge

English | [中文](README.zh.md)

## Summary

`dsh-sdk-assistant-stream-bridge` mounts on the `sdk` profile after `@deepseek-ai/dsh-sdk-jsonrpc-server`. It injects `sdkJsonRpc`, advertises the `assistant/live-chunk` capability, listens for Host `agent/assistant-stream` and durable `session/event` seqs, and notifies the client with transient `session.event` envelopes whose `type` is `assistant/live-chunk` (text-delta / reasoning-delta). Live chunks are not written to the durable session log — the same fold Web performs in `ClientAssistantStream`.

## Table of Contents

- [Use this package](#use-this-package)
- [Further Exploration](#further-exploration)

-----

<a id="use-this-package"></a>
## Use this package

Mount via the sdk-app bundle patch (`sdk-assistant-stream-bridge`) so desktop/native clients receive true token streaming over stdio. Desktop `ConversationStore` already ingests `assistant/live-chunk`.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-sdk-jsonrpc-server`](../server/README.md) — extension surface (`sdkJsonRpc`)
- [`dsh-sdk-approval-bridge`](../approval-bridge/README.md) — sibling extension pattern
- Web `ClientAssistantStream` — browser-side fold of `assistant-stream` follow frames
