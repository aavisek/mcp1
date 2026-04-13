/**
 * integer-fix-proxy/src/server.js
 *
 * Transparent HTTP proxy that sits in front of an Azure MCP Server and patches
 * the tools/list response so every occurrence of:
 *
 *   "type":"integer"
 *
 * in tool inputSchema definitions is rewritten to:
 *
 *   "type":"number"
 *
 * This is required because Copilot Studio's MCP runtime rejects the JSON Schema
 * keyword "integer" (only accepts the draft-07 standard set: string, number,
 * boolean, object, array, null).
 *
 * The proxy also rewrites any occurrence of the backend origin URL in response
 * bodies and headers (e.g. WWW-Authenticate, oauth-protected-resource) so that
 * Copilot Studio's OAuth discovery flow uses the proxy's public hostname.
 *
 * Environment variables:
 *   BACKEND_URL  – Full origin of the Azure MCP backend ACA (required).
 *                  Example: https://azure-mcp-storage-avd-server-v2.xxx.azurecontainerapps.io
 *   PORT         – Port to listen on (default: 8080).
 *   PROXY_HOST   – Override the proxy's own public hostname when request Host
 *                  header is not reliable (optional).
 */

import express from 'express';
import https from 'https';
import http from 'http';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 8080);
const BACKEND_URL = process.env.BACKEND_URL;

if (!BACKEND_URL) {
  console.error('[proxy] BACKEND_URL environment variable is required');
  process.exit(1);
}

const backendUrl = new URL(BACKEND_URL);
const backendOrigin = backendUrl.origin;           // e.g. https://foo.azurecontainerapps.io
const httpLib = backendUrl.protocol === 'https:' ? https : http;

// HTTP hop-by-hop headers that must NOT be forwarded (request and response).
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

// Additional response headers we strip before re-emitting so Node can set
// correct values after we transform the body.
const STRIP_RESPONSE = new Set([...HOP_BY_HOP, 'content-encoding', 'content-length']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const backendOriginRe = new RegExp(escapeRegex(backendOrigin), 'g');

/**
 * Rewrite all backend-origin URLs and patch integer schema types in a text
 * body. Only the integer→number rewrite is strictly necessary; the URL
 * rewrite ensures OAuth discovery flows point to the proxy, not the backend.
 */
function transformBody(body, proxyOrigin) {
  let out = body;

  // Rewrite backend origin → proxy origin (handles WWW-Authenticate, PRM, etc.)
  if (out.includes(backendOrigin)) {
    out = out.replace(backendOriginRe, proxyOrigin);
  }

  // Patch schema: "type":"integer" → "type":"number" (Copilot Studio compatibility)
  if (out.includes('"type":"integer"')) {
    out = out.replace(/"type":"integer"/g, '"type":"number"');
  }

  return out;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// Request logger
app.use((req, _res, next) => {
  _res.on('finish', () => {
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.url} → ${_res.statusCode}`
    );
  });
  next();
});

// Simple health/liveness probe (does not hit the backend)
app.get('/health', (_req, res) => res.send('ok'));

// ---------------------------------------------------------------------------
// Proxy handler – catches all methods and paths
// ---------------------------------------------------------------------------

app.use((req, res) => {
  // Determine this proxy's public origin from the incoming request.
  const proxyHost =
    process.env.PROXY_HOST ||
    req.headers['x-forwarded-host'] ||
    req.headers['host'] ||
    `localhost:${PORT}`;
  const proxyProto = req.headers['x-forwarded-proto'] || 'https';
  const proxyOrigin = `${proxyProto}://${proxyHost}`;

  // Collect the incoming request body (MCP requests are small JSON payloads).
  const reqChunks = [];
  req.on('data', chunk => reqChunks.push(chunk));
  req.on('error', err => {
    console.error('[proxy] Incoming request error:', err.message);
  });

  req.on('end', () => {
    const reqBody = Buffer.concat(reqChunks);

    // ------------------------------------------------------------------
    // Build forwarded request headers
    // ------------------------------------------------------------------
    const fwdHeaders = {};

    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) {
        fwdHeaders[k] = v;
      }
    }

    // Override host to match the backend.
    fwdHeaders['host'] = backendUrl.host;

    // Disable compression so the body is always plaintext and we can transform it.
    fwdHeaders['accept-encoding'] = 'identity';

    // Set explicit content-length for the forwarded body.
    fwdHeaders['content-length'] = String(reqBody.length);

    // ------------------------------------------------------------------
    // Forward request to backend
    // ------------------------------------------------------------------
    const options = {
      hostname: backendUrl.hostname,
      port: Number(backendUrl.port) || (backendUrl.protocol === 'https:' ? 443 : 80),
      path: req.url,
      method: req.method,
      headers: fwdHeaders,
      // Use a generous timeout; Azure MCP tool calls can take several seconds.
      timeout: 60_000,
    };

    const proxyReq = httpLib.request(options, proxyRes => {
      // Collect backend response body.
      const resChunks = [];
      proxyRes.on('data', chunk => resChunks.push(chunk));

      proxyRes.on('end', () => {
        const rawBody = Buffer.concat(resChunks).toString('utf8');
        const transformedBody = transformBody(rawBody, proxyOrigin);
        const bodyBuffer = Buffer.from(transformedBody, 'utf8');

        // Build clean response headers.
        const respHeaders = {};

        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (STRIP_RESPONSE.has(k.toLowerCase())) continue;

          // Rewrite any backend-origin URLs that appear in headers (e.g.
          // WWW-Authenticate, Location).
          const vals = Array.isArray(v) ? v : [v];
          respHeaders[k] = vals.map(hv =>
            typeof hv === 'string' ? hv.replace(backendOriginRe, proxyOrigin) : hv
          );
        }

        // Set the correct content-length for the (possibly transformed) body.
        respHeaders['content-length'] = String(bodyBuffer.length);

        res.writeHead(proxyRes.statusCode, respHeaders);
        res.end(bodyBuffer);
      });

      proxyRes.on('error', err => {
        console.error('[proxy] Backend response error:', err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bad Gateway', detail: err.message }));
        }
      });
    });

    proxyReq.on('error', err => {
      console.error('[proxy] Backend connection error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Gateway', detail: err.message }));
      }
    });

    proxyReq.on('timeout', () => {
      console.error('[proxy] Backend request timed out');
      proxyReq.destroy();
    });

    if (reqBody.length > 0) {
      proxyReq.write(reqBody);
    }
    proxyReq.end();
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] Listening on port ${PORT}`);
  console.log(`[proxy] Backend: ${BACKEND_URL}`);
});
