import dotenv from "dotenv";
dotenv.config();

import express from "express";
import session from "express-session";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync } from "fs";
import { randomBytes } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { getDb, loadAllowedEmails, deleteExpiredTokens } from "./db.js";
import { getOrCreateSession } from "./session-manager.js";
import oauthRouter, { requireBearerToken } from "./auth/oauth.js";
import { getAllowedRedirectUris, readPositiveInt } from "./auth/policy.js";
import onboardingRouter from "./onboarding.js";
import { registerAllTools } from "../tools/index.js";
import { isGoogleEnabled } from "./auth/providers/google.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT, 10) || 3000;

// ── Startup validation ────────────────────────────────────────────────────────

function validateEnv() {
  const required = ["SERVER_SECRET_KEY", "SESSION_SECRET"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (process.env.SERVER_SECRET_KEY.length !== 64) {
    console.error("SERVER_SECRET_KEY must be a 64-character hex string (32 bytes).");
    process.exit(1);
  }
  if (!process.env.BASE_URL) {
    console.warn("BASE_URL not set — will derive from incoming request Host header (fine for dev/tunnel use)");
  }
  getAllowedRedirectUris();
  readPositiveInt(
    process.env.OAUTH_DCR_REGISTRATIONS_PER_HOUR,
    5,
    "OAUTH_DCR_REGISTRATIONS_PER_HOUR",
  );
  readPositiveInt(
    process.env.OAUTH_DCR_MAX_PUBLIC_CLIENTS,
    25,
    "OAUTH_DCR_MAX_PUBLIC_CLIENTS",
  );
  loadAllowedEmails(); // Will throw + exit if file missing
}

// ── Express app setup ─────────────────────────────────────────────────────────

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Trust the first proxy (Cloudflare Tunnel) so req.secure reflects the
// original HTTPS connection. This also makes session cookies work correctly
// when accessed through the tunnel.
app.set("trust proxy", 1);

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    // secure=true only when the request actually arrived over HTTPS (via proxy).
    // When testing locally over plain HTTP this will be false, allowing cookies to work.
    secure: "auto",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// ── Request logging ───────────────────────────────────────────────────────────

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      `${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms) ` +
      `session:${req.session?.id?.slice(0, 8) ?? "none"} ` +
      `user:${req.userId ?? req.session?.userId ?? "-"} ` +
      `client:${req.clientId?.slice(0, 8) ?? "-"} source:${req.actorSource ?? "-"}`,
    );
  });
  next();
});

function logRequestError(context, error) {
  console.error(`${context} name=${error?.name || "Error"} code=${error?.code || "-"}`);
}

// View engine (simple HTML template rendering via res.render)
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "html");
app.engine("html", (filePath, options, callback) => {
  try {
    let content = readFileSync(filePath, "utf8");
    for (const [k, v] of Object.entries(options)) {
      // Section toggle: <!-- if:key -->...<!-- endif:key -->
      // Truthy = boolean true, non-empty string, non-zero number
      const startTag = `<!-- if:${k} -->`;
      const endTag = `<!-- endif:${k} -->`;
      if (content.includes(startTag)) {
        const truthy = v !== null && v !== undefined && v !== false && v !== "" && v !== 0;
        if (!truthy) {
          const re = new RegExp(startTag + "[\\s\\S]*?" + endTag, "g");
          content = content.replace(re, "");
        } else {
          content = content.replaceAll(startTag, "").replaceAll(endTag, "");
        }
      }
      // Value replacement: {{key}}
      if (typeof v === "string" || typeof v === "number") {
        content = content.replaceAll(`{{${k}}}`, String(v));
      } else if (v === null || v === undefined) {
        content = content.replaceAll(`{{${k}}}`, "");
      }
    }
    callback(null, content);
  } catch (err) {
    callback(err);
  }
});

// ── Login page ────────────────────────────────────────────────────────────────

app.get("/login", (_req, res) => {
  res.render("login", {
    error: "",
    googleEnabled: isGoogleEnabled(),
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  });
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ── OAuth + onboarding routes ─────────────────────────────────────────────────

app.use(oauthRouter);
app.use("/mcp", oauthRouter);
app.use(onboardingRouter);

// ── MCP Streamable HTTP endpoint ──────────────────────────────────────────────
//
// Per the MCP spec, we use stateful sessions: one McpServer + transport per
// session, keyed by the Mcp-Session-Id header. This is required for elicitation
// to work (the server needs to maintain request context across the session).

const mcpSessions = new Map(); // sessionId → { server, transport }

function createMcpServer(userId, clientProfile = "full") {
  const mcpServer = new McpServer({
    name: clientProfile === "gina" ? "anylist-mcp-gina" : "anylist-mcp-server",
    version: "2.1.0",
  });
  registerAllTools(mcpServer, () => getOrCreateSession(userId), { profile: clientProfile });
  return mcpServer;
}

// MCP endpoint — available at both / and /mcp.
// All specific routes above (/health, /login, /oauth/*, etc.) take precedence.
async function handleMcp(req, res) {
  try {
    const sessionId = req.headers["mcp-session-id"];
    // Initialize requests always create a new session — never route to an existing one.
    // This handles clients (e.g. HA) that send a second initialize on a stale session ID.
    const mcpSession = !isInitializeRequest(req.body) && sessionId
      ? mcpSessions.get(sessionId)
      : null;

    if (mcpSession && (
      mcpSession.userId !== req.userId ||
      mcpSession.clientId !== req.clientId
    )) {
      return res.status(403).json({ error: "MCP session belongs to a different OAuth client." });
    }

    if (!mcpSession) {
      if (!isInitializeRequest(req.body)) {
        return res.status(404).json({ error: "Session not found. Send an initialize request first." });
      }

      // Create a new MCP session for this user
      const userId = req.userId;
      const mcpServer = createMcpServer(userId, req.clientProfile);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString("hex"),
        onsessioninitialized: (sid) => {
          mcpSessions.set(sid, {
            server: mcpServer,
            transport,
            userId: req.userId,
            clientId: req.clientId,
          });
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) mcpSessions.delete(sid);
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    await mcpSession.transport.handleRequest(req, res, req.body);
  } catch (err) {
    logRequestError("MCP request error", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
}

app.all("/", requireBearerToken, handleMcp);
app.all("/mcp", requireBearerToken, handleMcp);

// ── MCP SSE transport endpoints (for Home Assistant and other SSE-only clients) ─

function makeSseConnectHandler(postEndpoint) {
  return async function (req, res) {
    try {
      const transport = new SSEServerTransport(postEndpoint, res);
      const sessionId = transport.sessionId;
      const mcpServer = createMcpServer(req.userId, req.clientProfile);
      mcpSessions.set(sessionId, {
        server: mcpServer,
        transport,
        userId: req.userId,
        clientId: req.clientId,
      });
      transport.onclose = () => { mcpSessions.delete(sessionId); };
      await mcpServer.connect(transport); // connect() calls transport.start() internally
    } catch (err) {
      logRequestError("SSE connect error", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  };
}

async function handleSseMessage(req, res) {
  try {
    const mcpSession = req.query.sessionId ? mcpSessions.get(req.query.sessionId) : null;
    if (!mcpSession || !(mcpSession.transport instanceof SSEServerTransport)) {
      return res.status(404).json({ error: "SSE session not found." });
    }
    if (mcpSession.userId !== req.userId || mcpSession.clientId !== req.clientId) {
      return res.status(403).json({ error: "MCP session belongs to a different OAuth client." });
    }
    await mcpSession.transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    logRequestError("SSE message error", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
}

app.get("/sse",       requireBearerToken, makeSseConnectHandler("/messages"));
app.post("/sse",      requireBearerToken, handleMcp); // HA uses Streamable HTTP at this URL
app.post("/messages", requireBearerToken, handleSseMessage);

// ── Cleanup job ───────────────────────────────────────────────────────────────

setInterval(deleteExpiredTokens, 60 * 60 * 1000); // hourly

// ── Start server ──────────────────────────────────────────────────────────────

validateEnv();
getDb(); // Initialize DB (runs migrations)

app.listen(PORT, () => {
  console.log(`anylist-mcp HTTP server listening on port ${PORT}`);
  console.log(`Base URL: ${process.env.BASE_URL || "(derived from request host)"}`);
  console.log(`Google OAuth: ${isGoogleEnabled() ? "enabled" : "disabled (set GOOGLE_CLIENT_ID to enable)"}`);
});
