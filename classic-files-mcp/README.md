# Classic Azure Files MCP Companion

This is a standalone companion MCP server that adds support for classic Azure Files shares under `Microsoft.Storage/storageAccounts/fileServices/shares`.

It is intentionally separate from your existing Azure MCP server so current behavior is not changed.

## What It Adds

- `classic_files_share_list`
  - Lists classic file shares in a storage account.
- `classic_files_share_get`
  - Gets one classic file share by name.

## Why This Exists

Built-in Azure MCP namespaces currently split capabilities:

- `fileshares` namespace targets `Microsoft.FileShares` (managed NFS preview).
- `storage` namespace covers account/blob/container/table, but not classic SMB file share list/get.

FSLogix typically uses classic SMB shares in storage accounts, so this companion server fills that gap.

## Prerequisites

- Node.js 20+
- Azure identity available to the process (managed identity, Azure CLI sign-in, or service principal env vars)
- RBAC for the identity:
  - Management plane read permissions on target storage accounts (for example, Reader)

## Run Locally

```bash
cd classic-files-mcp
npm install
npm start
```

Server endpoints:

- MCP endpoint: `POST /`
- Health probe: `GET /health`

Default port is `8081`. Override with `PORT`.

## Tool Inputs

Both tools require:

- `subscriptionId`
- `resourceGroup`
- `storageAccount`

`classic_files_share_get` additionally requires:

- `shareName`

## Example Prompt Ideas

- "Use tool classic_files_share_list with subscription `...`, resource group `VDI-A-RG`, and storage account `avdsainddev01`."
- "Use tool classic_files_share_get for share `avdfile` in storage account `avdsainddev01`."

## Notes

- This server is read-only.
- It does not alter your existing `infra` deployment unless you explicitly wire it in.
