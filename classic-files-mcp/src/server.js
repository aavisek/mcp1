
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

function normalizeFilePath(filePath = "") {
  if (typeof filePath !== "string") {
    return "";
  }

  return filePath.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function splitFilePath(filePath) {
  const normalizedPath = normalizeFilePath(filePath);
  if (!normalizedPath) {
    throw new Error("Missing required argument: filePath");
  }

  const parts = normalizedPath.split("/").filter(Boolean);
  const fileName = parts.pop();

  if (!fileName) {
    throw new Error(`Invalid file path: ${filePath}`);
  }

  return {
    normalizedPath,
    parentDirectoryPath: parts.join("/"),
    fileName
  };
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

async function getFileClient(storageAccount, shareName, filePath) {
  const { normalizedPath, parentDirectoryPath, fileName } = splitFilePath(filePath);
  const { directoryClient } = await getDirectoryClient(storageAccount, shareName, parentDirectoryPath);
  const fileClient = directoryClient.getFileClient(fileName);
  const fileExists = await fileClient.exists(FILE_REQUEST_INTENT_OPTIONS);

  if (!fileExists) {
    throw new Error(`File not found: ${normalizedPath}`);
  }

  return { fileClient, normalizedPath };
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

async function listDirectoryEntriesRecursive({
  storageAccount,
  shareName,
  directoryPath = "",
  maxItems = 1000
}) {
  const { directoryClient, normalizedPath } = await getDirectoryClient(
    storageAccount,
    shareName,
    directoryPath
  );

  const entries = [];

  async function walkDirectory(currentDirectoryClient, currentPath) {
    for await (const item of currentDirectoryClient.listFilesAndDirectories(FILE_REQUEST_INTENT_OPTIONS)) {
      if (entries.length >= maxItems) {
        return;
      }

      const itemPath = combinePath(currentPath, item.name);
      if (item.kind === "directory") {
        entries.push({
          name: item.name,
          path: itemPath,
          kind: "directory"
        });

        const childDirectoryClient = currentDirectoryClient.getDirectoryClient(item.name);
        await walkDirectory(childDirectoryClient, itemPath);
      } else {
        entries.push({
          name: item.name,
          path: itemPath,
          kind: "file",
          sizeBytes: item.properties?.contentLength ?? 0
        });
      }

      if (entries.length >= maxItems) {
        return;
      }
    }
  }

  await walkDirectory(directoryClient, normalizedPath);

  return {
    message: "Recursive directory entries retrieved.",
    shareName,
    directoryPath: normalizedPath || "/",
    count: entries.length,
    maxItems,
    isTruncated: entries.length >= maxItems,
    entries
  };
}

async function getFileProperties({ storageAccount, shareName, filePath }) {
  const { fileClient, normalizedPath } = await getFileClient(storageAccount, shareName, filePath);
  const properties = await fileClient.getProperties(FILE_REQUEST_INTENT_OPTIONS);

  return {
    message: "File properties retrieved.",
    shareName,
    filePath: normalizedPath,
    sizeBytes: properties.contentLength ?? 0,
    contentType: properties.contentType,
    etag: properties.etag,
    lastModified: properties.lastModified,
    fileAttributes: properties.fileAttributes,
    filePermissionKey: properties.filePermissionKey
  };
}

async function getShareStats({ storageAccount, shareName }) {
  const { directoryClient } = await getDirectoryClient(storageAccount, shareName, "");
  const result = await calculateDirectorySizeRecursive(directoryClient);

  return {
    message: "Share statistics calculated.",
    shareName,
    totalBytes: result.totalBytes,
    totalMiB: Number((result.totalBytes / (1024 * 1024)).toFixed(3)),
    totalGiB: Number((result.totalBytes / (1024 * 1024 * 1024)).toFixed(3)),
    fileCount: result.fileCount,
    folderCount: result.folderCount
  };
}

const TOOL_CATALOG = [
  {
    name: "classic_files_share_list",
    title: "List Classic Azure Files Shares",
    description: "List classic Azure Files shares under Microsoft.Storage for a given storage account.",
    inputSchema: {
      type: "object",
      properties: {
        subscriptionId: { type: "string", minLength: 1 },
        resourceGroup: { type: "string", minLength: 1 },
        storageAccount: { type: "string", minLength: 1 }
      },
      required: ["subscriptionId", "resourceGroup", "storageAccount"],
      additionalProperties: false
    },
    mcpInputSchema: {
      subscriptionId: z.string().min(1),
      resourceGroup: z.string().min(1),
      storageAccount: z.string().min(1)
    },
    parser: z.object({
      subscriptionId: z.string().min(1),
      resourceGroup: z.string().min(1),
      storageAccount: z.string().min(1)
    }).strict(),
    run: listClassicFileShares
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
    },
    mcpInputSchema: {
      subscriptionId: z.string().min(1),
      resourceGroup: z.string().min(1),
      storageAccount: z.string().min(1),
      shareName: z.string().min(1)
    },
    parser: z.object({
      subscriptionId: z.string().min(1),
      resourceGroup: z.string().min(1),
      storageAccount: z.string().min(1),
      shareName: z.string().min(1)
    }).strict(),
    run: getClassicFileShare
  },
  {
    name: "classic_files_directory_list",
    title: "List Files And Folders In Share Path",
    description: "List files and folders under a specific path in a classic Azure Files share.",
    inputSchema: {
      type: "object",
      properties: {
        storageAccount: { type: "string", minLength: 1 },
        shareName: { type: "string", minLength: 1 },
        directoryPath: { type: "string" }
      },
      required: ["storageAccount", "shareName"],
      additionalProperties: false
    },
    mcpInputSchema: {
      storageAccount: z.string().min(1),
      shareName: z.string().min(1),
      directoryPath: z.string().optional()
    },
    parser: z.object({
      storageAccount: z.string().min(1),
      shareName: z.string().min(1),
      directoryPath: z.string().optional()
    }).strict(),
    run: listDirectoryEntries
  },
  {
    name: "classic_files_directory_size",
    title: "Get Folder Size In Share",
    description: "Calculate total size recursively for a folder path in a classic Azure Files share.",
    inputSchema: {
      type: "object",
      properties: {
        storageAccount: { type: "string", minLength: 1 },
        shareName: { type: "string", minLength: 1 },
        directoryPath: { type: "string" }
      },
      required: ["storageAccount", "shareName"],
      additionalProperties: false
    },
    mcpInputSchema: {
      storageAccount: z.string().min(1),
      shareName: z.string().min(1),
      directoryPath: z.string().optional()
    },
    parser: z.object({
      storageAccount: z.string().min(1),
      shareName: z.string().min(1),
      directoryPath: z.string().optional()
    }).strict(),
    run: getDirectorySize
  },
  {
    name: "classic_files_directory_list_recursive",
    title: "List Files Recursively In Share Path",
    description: "Recursively list files and folders under a path in a classic Azure Files share.",
    inputSchema: {
      type: "object",
      properties: {
        storageAccount: { type: "string", minLength: 1 },
        shareName: { type: "string", minLength: 1 },
        directoryPath: { type: "string" },
        maxItems: { type: "integer", minimum: 1, maximum: 5000 }
      },
      required: ["storageAccount", "shareName"],
      additionalProperties: false
    },
    mcpInputSchema: {
      storageAccount: z.string().min(1),
      shareName: z.string().min(1),
      directoryPath: z.string().optional(),
      maxItems: z.number().int().min(1).max(5000).optional()
    },
    parser: z.object({
      storageAccount: z.string().min(1),
      shareName: z.string().min(1),
      directoryPath: z.string().optional(),
      maxItems: z.number().int().min(1).max(5000).optional()
    }).strict(),
    run: listDirectoryEntriesRecursive
  },
  {
    name: "classic_files_file_get_properties",
    title: "Get File Properties In Share",
    description: "Get file metadata and size for a file in a classic Azure Files share.",
    inputSchema: {
      type: "object",
      properties: {
        storageAccount: { type: "string", minLength: 1 },
        shareName: { type: "string", minLength: 1 },
        filePath: { type: "string", minLength: 1 }
      },
      required: ["storageAccount", "shareName", "filePath"],
      additionalProperties: false
    },
    mcpInputSchema: {
      storageAccount: z.string().min(1),
      shareName: z.string().min(1),
      filePath: z.string().min(1)
    },
    parser: z.object({
      storageAccount: z.string().min(1),
      shareName: z.string().min(1),
      filePath: z.string().min(1)
    }).strict(),
    run: getFileProperties
  },
  {
    name: "classic_files_share_stats",
    title: "Get Share Statistics",
    description: "Calculate total bytes, file count, and folder count for an entire share.",
    inputSchema: {
      type: "object",
      properties: {
        storageAccount: { type: "string", minLength: 1 },
        shareName: { type: "string", minLength: 1 }
      },
      required: ["storageAccount", "shareName"],
      additionalProperties: false
    },
    mcpInputSchema: {
      storageAccount: z.string().min(1),
      shareName: z.string().min(1)
    },
    parser: z.object({
      storageAccount: z.string().min(1),
      shareName: z.string().min(1)
    }).strict(),
    run: getShareStats
  }
];

const TOOL_DEFINITIONS = TOOL_CATALOG.map(({ name, title, description, inputSchema }) => ({
  name,
  title,
  description,
  inputSchema
}));

const TOOL_EXECUTORS = new Map(TOOL_CATALOG.map((tool) => [tool.name, tool]));

function buildToolArgumentGuidance(toolName, toolArgs, error) {
  const tool = TOOL_EXECUTORS.get(toolName);
  const requiredArguments = tool?.inputSchema?.required ?? [];
  const receivedArguments = toolArgs && typeof toolArgs === "object" ? Object.keys(toolArgs) : [];

  return {
    errorType: "InvalidToolArguments",
    message: error instanceof Error ? error.message : "Tool arguments are invalid.",
    toolName,
    requiredArguments,
    receivedArguments,
    guidance:
      "Provide all required arguments exactly as listed in the tool input schema and retry."
  };
}

async function executeTool(name, args) {
  const tool = TOOL_EXECUTORS.get(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const parsedArgs = tool.parser.parse(args ?? {});
  return tool.run(parsedArgs);
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

        let toolOutput;
        try {
          toolOutput = await executeTool(toolName, toolArgs);
        } catch (error) {
          toolOutput = buildToolArgumentGuidance(toolName, toolArgs, error);
        }

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

  for (const tool of TOOL_CATALOG) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.mcpInputSchema
      },
      async (argumentsInput) => {
        const result = await tool.run(tool.parser.parse(argumentsInput));

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
  }

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

app.get("/.well-known/mcp.json", (_req, res) => {
  res.status(200).json({
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
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Classic Azure Files MCP server listening on port ${PORT}`);
});