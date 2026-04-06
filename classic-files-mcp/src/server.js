import express from "express";
import { randomUUID } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { StorageManagementClient } from "@azure/arm-storage";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8081);
const credential = new DefaultAzureCredential();

function storageClient(subscriptionId) {
  return new StorageManagementClient(credential, subscriptionId);
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
      const client = storageClient(subscriptionId);
      const shares = [];

      for await (const share of client.fileShares.list(resourceGroup, storageAccount)) {
        shares.push(normalizeShare(share));
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                message: "Classic file shares retrieved.",
                count: shares.length,
                shares
              },
              null,
              2
            )
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
      const client = storageClient(subscriptionId);
      const share = await client.fileShares.get(resourceGroup, storageAccount, shareName);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                message: "Classic file share retrieved.",
                share: normalizeShare(share)
              },
              null,
              2
            )
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