import express from "express";
import { randomUUID } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { StorageManagementClient } from "@azure/arm-storage";
import { ShareServiceClient } from "@azure/storage-file-share";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8081);
const credential = new DefaultAzureCredential();
const FILE_REQUEST_INTENT_OPTIONS = { fileRequestIntent: "backup" };

function storageClient(subscriptionId) {
  return new StorageManagementClient(credential, subscriptionId);
}

function shareServiceClient(storageAccount) {
  return new ShareServiceClient(`https://${storageAccount}.file.core.windows.net`, credential);
}

function normalizeDirectoryPath(directoryPath = "") {
  if (typeof directoryPath !== "string") {
    return "";
  }

  return directoryPath.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function combinePath(base, name) {
  return base ? `${base}/${name}` : name;
}

function normalizeShare(share) {
  return {
    id: share.id,
    name: share.name,
    type: share.type,
    resourceGroup: share.resourceGroup,
    location: share.location,
    accessTier: share.accessTier,
    enabledProtocols: share.enabledProtocols,
    shareQuotaGiB: share.shareQuota,
    leaseStatus: share.leaseStatus,
    leaseState: share.leaseState,
    lastModifiedTime: share.lastModifiedTime,
    etag: share.etag
  };
}

const TOOL_DEFINITIONS = [
  {
    name: "classic_files_share_list",
    title: "List Classic Azure Files Shares",
    description:
      "List classic Azure Files shares under Microsoft.Storage for a given storage account.",
    inputSchema: {
      type: "object",
      properties: {
        subscriptionId: { type: "string", minLength: 1 },
        resourceGroup: { type: "string", minLength: 1 },
        storageAccount: { type: "string", minLength: 1 }
      },
      required: ["subscriptionId", "resourceGroup", "storageAccount"],
      additionalProperties: false
    }
  },
  {
    name: "classic_files_share_get",
    title: "Get Classic Azure Files Share",
    description: "Get details for a specific classic Azure Files share under Microsoft.Storage.",
    inputSchema: {
      type: "object",
      properties: {
        subscriptionId: { type: "string", minLength: 1 },
        resourceGroup: { type: "string", minLength: 1 },
        storageAccount: { type: "string", minLength: 1 },
        shareName: { type: "string", minLength: 1 }
      },
      required: ["subscriptionId", "resourceGroup", "storageAccount", "shareName"],
      additionalProperties: false
    }
  },
  {
    name: "classic_files_directory_list",
    title: "List Files And Folders In Share Path",
    description:
      "List files and folders under a specific path in a classic Azure Files share.",
    inputSchema: {
      type: "object",
      properties: {
        storageAccount: { type: "string", minLength: 1 },
        shareName: { type: "string", minLength: 1 },
        directoryPath: { type: "string" }
      },
      required: ["storageAccount", "shareName"],
      additionalProperties: false
    }
  },
  {
    name: "classic_files_directory_size",
    title: "Get Folder Size In Share",
    description:
      "Calculate total size recursively for a folder path in a classic Azure Files share.",
    inputSchema: {
      type: "object",
      properties: {
        storageAccount: { type: "string", minLength: 1 },
        shareName: { type: "string", minLength: 1 },
        directoryPath: { type: "string" }
      },
      required: ["storageAccount", "shareName"],
      additionalProperties: false
    }
  }
];

async function listClassicFileShares({ subscriptionId, resourceGroup, storageAccount }) {
  const client = storageClient(subscriptionId);
  const shares = [];

  for await (const share of client.fileShares.list(resourceGroup, storageAccount)) {
    shares.push(normalizeShare(share));
  }

  return {
    message: "Classic file shares retrieved.",
    count: shares.length,
    shares
  };
}

async function getClassicFileShare({ subscriptionId, resourceGroup, storageAccount, shareName }) {
  const client = storageClient(subscriptionId);
  const share = await client.fileShares.get(resourceGroup, storageAccount, shareName);

  return {
    message: "Classic file share retrieved.",
    share: normalizeShare(share)
  };
}

async function getDirectoryClient(storageAccount, shareName, directoryPath = "") {
  const normalizedPath = normalizeDirectoryPath(directoryPath);
  const serviceClient = shareServiceClient(storageAccount);
  const shareClient = serviceClient.getShareClient(shareName);

  const shareExists = await shareClient.exists(FILE_REQUEST_INTENT_OPTIONS);
  if (!shareExists) {
    throw new Error(`Share not found: ${shareName}`);
  }

  const directoryClient = normalizedPath
    ? shareClient.getDirectoryClient(normalizedPath)
    : shareClient.rootDirectoryClient;

  const directoryExists = await directoryClient.exists(FILE_REQUEST_INTENT_OPTIONS);
  if (!directoryExists) {
    throw new Error(`Directory not found: ${normalizedPath || "/"}`);
  }

  return { directoryClient, normalizedPath };
}

async function listDirectoryEntries({ storageAccount, shareName, directoryPath = "" }) {
  const { directoryClient, normalizedPath } = await getDirectoryClient(
    storageAccount,
    shareName,
    directoryPath
  );

  const entries = [];
  for await (const item of directoryClient.listFilesAndDirectories(FILE_REQUEST_INTENT_OPTIONS)) {
    if (item.kind === "directory") {
      entries.push({
        name: item.name,
        path: combinePath(normalizedPath, item.name),
        kind: "directory"
      });
    } else {
      entries.push({
        name: item.name,
        path: combinePath(normalizedPath, item.name),
        kind: "file",
        sizeBytes: item.properties?.contentLength ?? 0
      });
    }
  }

  return {
    message: "Directory entries retrieved.",
    shareName,
    directoryPath: normalizedPath || "/",
    count: entries.length,
    entries
  };
}

async function calculateDirectorySizeRecursive(directoryClient) {
  let totalBytes = 0;
  let fileCount = 0;
  let folderCount = 0;

  for await (const item of directoryClient.listFilesAndDirectories(FILE_REQUEST_INTENT_OPTIONS)) {
    if (item.kind === "directory") {
      folderCount += 1;
      const childDirectoryClient = directoryClient.getDirectoryClient(item.name);
      const child = await calculateDirectorySizeRecursive(childDirectoryClient);
      totalBytes += child.totalBytes;
      fileCount += child.fileCount;
      folderCount += child.folderCount;
    } else {
      totalBytes += item.properties?.contentLength ?? 0;
      fileCount += 1;
    }
  }

  return { totalBytes, fileCount, folderCount };
}

async function getDirectorySize({ storageAccount, shareName, directoryPath = "" }) {
  const { directoryClient, normalizedPath } = await getDirectoryClient(
    storageAccount,
    shareName,
    directoryPath
  );

  const result = await calculateDirectorySizeRecursive(directoryClient);

  return {
    message: "Directory size calculated.",
    shareName,
    directoryPath: normalizedPath || "/",
    totalBytes: result.totalBytes,
    totalMiB: Number((result.totalBytes / (1024 * 1024)).toFixed(3)),
    totalGiB: Number((result.totalBytes / (1024 * 1024 * 1024)).toFixed(3)),
    fileCount: result.fileCount,
    folderCount: result.folderCount
  };
}

function validateRequired(args, requiredFields) {
  for (const field of requiredFields) {
    if (typeof args?.[field] !== "string" || args[field].trim().length === 0) {
      throw new Error(`Missing required argument: ${field}`);
    }
  }
}

async function executeTool(name, args) {
  if (name === "classic_files_share_list") {
    validateRequired(args, ["subscriptionId", "resourceGroup", "storageAccount"]);
    return listClassicFileShares(args);
  }

  if (name === "classic_files_share_get") {
    validateRequired(args, ["subscriptionId", "resourceGroup", "storageAccount", "shareName"]);
    return getClassicFileShare(args);
  }

  if (name === "classic_files_directory_list") {
    validateRequired(args, ["storageAccount", "shareName"]);
    return listDirectoryEntries(args);
  }

  if (name === "classic_files_directory_size") {
    validateRequired(args, ["storageAccount", "shareName"]);
    return getDirectorySize(args);
  }

  throw new Error(`Unknown tool: ${name}`);
}

function buildInitializeResult() {
  return {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: {
        listChanged: true
      }
    },
    serverInfo: {
      name: "classic-azure-files-mcp",
      version: "0.1.0"
    }
  };
}

async function handleStatelessRpc(request) {
  const id = Object.prototype.hasOwnProperty.call(request, "id") ? request.id : null;

  try {
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: buildInitializeResult()
        };
      case "initialized":
      case "notifications/initialized":
        return {
          jsonrpc: "2.0",
          id,
          result: {}
        };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: TOOL_DEFINITIONS
          }
        };
      case "tools/call": {
        const toolName = request?.params?.name;
        const toolArgs = request?.params?.arguments ?? {};
        const toolOutput = await executeTool(toolName, toolArgs);

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(toolOutput, null, 2)
              }
            ]
          }
        };
      }
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${request.method}`
          }
        };
    }
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : "Unknown error"
      }
    };
  }
}

function shouldUseStatelessFallback(sessionId, payload) {
  if (typeof sessionId === "string" && sessionId.length > 0) {
    return false;
  }

  const requests = Array.isArray(payload) ? payload : [payload];
  return requests.every(
    (req) =>
      req &&
      typeof req === "object" &&
      req.jsonrpc === "2.0" &&
      typeof req.method === "string" &&
      ["initialize", "initialized", "notifications/initialized", "tools/list", "tools/call"].includes(
        req.method
      )
  );
}

function createServer() {
  const server = new McpServer({
    name: "classic-azure-files-mcp",
    version: "0.1.0"
  });

  server.registerTool(
    "classic_files_share_list",
    {
      title: "List Classic Azure Files Shares",
      description:
        "List classic Azure Files shares under Microsoft.Storage for a given storage account.",
      inputSchema: {
        subscriptionId: z.string().min(1),
        resourceGroup: z.string().min(1),
        storageAccount: z.string().min(1)
      }
    },
    async ({ subscriptionId, resourceGroup, storageAccount }) => {
      const result = await listClassicFileShares({ subscriptionId, resourceGroup, storageAccount });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  );

  server.registerTool(
    "classic_files_share_get",
    {
      title: "Get Classic Azure Files Share",
      description:
        "Get details for a specific classic Azure Files share under Microsoft.Storage.",
      inputSchema: {
        subscriptionId: z.string().min(1),
        resourceGroup: z.string().min(1),
        storageAccount: z.string().min(1),
        shareName: z.string().min(1)
      }
    },
    async ({ subscriptionId, resourceGroup, storageAccount, shareName }) => {
      const result = await getClassicFileShare({
        subscriptionId,
        resourceGroup,
        storageAccount,
        shareName
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  );

  server.registerTool(
    "classic_files_directory_list",
    {
      title: "List Files And Folders In Share Path",
      description: "List files and folders under a specific path in a classic Azure Files share.",
      inputSchema: {
        storageAccount: z.string().min(1),
        shareName: z.string().min(1),
        directoryPath: z.string().optional()
      }
    },
    async ({ storageAccount, shareName, directoryPath }) => {
      const result = await listDirectoryEntries({ storageAccount, shareName, directoryPath });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  );

  server.registerTool(
    "classic_files_directory_size",
    {
      title: "Get Folder Size In Share",
      description: "Calculate total size recursively for a folder path in a classic Azure Files share.",
      inputSchema: {
        storageAccount: z.string().min(1),
        shareName: z.string().min(1),
        directoryPath: z.string().optional()
      }
    },
    async ({ storageAccount, shareName, directoryPath }) => {
      const result = await getDirectorySize({ storageAccount, shareName, directoryPath });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  );

  return server;
}

const transports = new Map();

app.post("/", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];

    if (shouldUseStatelessFallback(sessionId, req.body)) {
      const requests = Array.isArray(req.body) ? req.body : [req.body];
      const responses = [];

      for (const request of requests) {
        // JSON-RPC notifications do not require responses.
        if (request && !Object.prototype.hasOwnProperty.call(request, "id")) {
          // Keep compatibility by accepting notifications silently.
          // eslint-disable-next-line no-continue
          continue;
        }

        responses.push(await handleStatelessRpc(request));
      }

      if (Array.isArray(req.body)) {
        return res.status(200).json(responses);
      }

      if (responses.length === 0) {
        return res.status(202).end();
      }

      return res.status(200).json(responses[0]);
    }

    let transport;

    if (typeof sessionId === "string" && transports.has(sessionId)) {
      transport = transports.get(sessionId);
    } else {
      const server = createServer();

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports.set(newSessionId, transport);
        }
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    res.status(500).json({
      error: "InternalServerError",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Classic Azure Files MCP server listening on port ${PORT}`);
});