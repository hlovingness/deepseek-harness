---
description: "SDK-profile Cordis plugin that bridges Host approval/request waterfall asks to out-of-process approval.require / approval/respond over the shared JSON-RPC channel."
kind: "package-reference"
---

# @deepseek-ai/dsh-sdk-approval-bridge

English | [中文](README.zh.md)

## Summary

`dsh-sdk-approval-bridge` mounts on the `sdk` profile after `@deepseek-ai/dsh-sdk-jsonrpc-server`. It injects `sdkJsonRpc`, advertises the `approval/respond` capability, listens for Host `approval/request`, notifies the client with `approval.require`, and settles outcomes as `allowed-once` / `rejected` / `cancelled`. Approval is not baked into the JSON-RPC server core.

## Table of Contents

- [Use this package](#use-this-package)
- [Further Exploration](#further-exploration)

-----

<a id="use-this-package"></a>
## Use this package

Mount via the sdk-app bundle patch (`sdk-approval-bridge`) so desktop/native clients can answer tool approvals over stdio. Wire shapes live in `@deepseek-ai/dsh-sdk-protocol`; Host vocabulary stays one-shot (`allowed-once` / `rejected`).

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-sdk-jsonrpc-server`](../server/README.md) — extension surface (`sdkJsonRpc`)
- [`dsh-sdk-protocol`](../protocol/README.md) — `approval.require` / `approval/respond` types
- [`dsh-user-approval`](../../interaction/user-approval/README.md) — Host `approval/request` waterfall
