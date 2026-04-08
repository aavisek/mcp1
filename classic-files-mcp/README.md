# Classic Azure Files MCP Companion

This is a standalone companion MCP server that adds support for classic Azure Files shares under `Microsoft.Storage/storageAccounts/fileServices/shares`.

It is intentionally separate from your existing Azure MCP server so current behavior is not changed.

## What It Adds

- `classic_files_share_list`
  - Lists classic file shares in a storage account.
- `classic_files_share_get`
  - Gets one classic file share by name.
- `classic_files_directory_list`
  - Lists files and folders for one directory path.
- `classic_files_directory_size`
  - Calculates recursive size for one directory path.
- `classic_files_directory_list_recursive`
  - Recursively lists files and folders from a path with a `maxItems` limit.
- `classic_files_file_get_properties`
  - Gets metadata and size for one file path.
- `classic_files_share_stats`
  - Calculates total bytes, file count, and folder count for an entire share.

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

- Share management tools:
  - `classic_files_share_list` requires `subscriptionId`, `resourceGroup`, `storageAccount`.
  - `classic_files_share_get` requires `subscriptionId`, `resourceGroup`, `storageAccount`, `shareName`.
- Share data tools:
  - `classic_files_directory_list` requires `storageAccount`, `shareName`, optional `directoryPath`.
  - `classic_files_directory_size` requires `storageAccount`, `shareName`, optional `directoryPath`.
  - `classic_files_directory_list_recursive` requires `storageAccount`, `shareName`, optional `directoryPath`, optional `maxItems`.
  - `classic_files_file_get_properties` requires `storageAccount`, `shareName`, `filePath`.
  - `classic_files_share_stats` requires `storageAccount`, `shareName`.

## Example Prompt Ideas

- "Use tool classic_files_share_list with subscription `...`, resource group `VDI-A-RG`, and storage account `avdsainddev01`."
- "Use tool classic_files_share_get for share `avdfile` in storage account `avdsainddev01`."

## Notes

- This server is read-only and can expose multiple MCP tools from a single endpoint.
- It does not alter your existing `infra` deployment unless you explicitly wire it in.
