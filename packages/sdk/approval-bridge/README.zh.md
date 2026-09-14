---
description: "SDK profile 上的 Cordis 插件：把 Host 的 approval/request waterfall 问询桥接到进程外的 approval.require / approval/respond（共用 JSON-RPC 通道）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sdk-approval-bridge

[English](README.md) | 中文

## 概述

`dsh-sdk-approval-bridge` 挂在 `sdk` profile 中、位于 `@deepseek-ai/dsh-sdk-jsonrpc-server` 之后。它注入 `sdkJsonRpc`，声明 `approval/respond` capability，监听 Host `approval/request`，向客户端 `notify('approval.require')`，并将结果映射为 `allowed-once` / `rejected` / `cancelled`。审批逻辑不内嵌在 JSON-RPC server 核心。

## 目录

- [使用本包](#use-this-package)
- [进一步探索](#further-exploration)

-----

<a id="use-this-package"></a>
## 使用本包

通过 sdk-app bundle patch（`sdk-approval-bridge`）挂载，使桌面／原生客户端能在 stdio 上回答工具审批。线协议形状在 `@deepseek-ai/dsh-sdk-protocol`；Host 词汇仍为一次性授权（`allowed-once` / `rejected`）。

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-sdk-jsonrpc-server`](../server/README.zh.md) — 扩展面（`sdkJsonRpc`）
- [`dsh-sdk-protocol`](../protocol/README.zh.md) — `approval.require` / `approval/respond` 类型
- [`dsh-user-approval`](../../interaction/user-approval/README.zh.md) — Host `approval/request` waterfall
