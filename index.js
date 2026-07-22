#!/usr/bin/env node
/**
 * gmail-writer MCP server.
 *
 * Provides Gmail write operations (label, unlabel, move) that the claude.ai
 * Gmail MCP cannot perform due to a tool cap limiting OAuth scope negotiation.
 * Also includes search and list_labels as backup reads.
 *
 * Token: ~/.gmail_token.json (created by the bundled oauth_bootstrap.py,
 * see README). The token file is self-contained: it includes client_id,
 * client_secret, and refresh_token, so no separate credentials file is
 * needed.
 *
 * Re-auth: if the token expires and can't be refreshed, re-run:
 *   uv run --with google-auth-oauthlib oauth_bootstrap.py client_secret.json
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, resolve, sep } from "node:path";
import { google } from "googleapis";

const TOKEN_PATH = join(homedir(), ".gmail_token.json");

// The token grants mail write access; warn if other users could read it.
try {
  if (existsSync(TOKEN_PATH) && (statSync(TOKEN_PATH).mode & 0o077) !== 0) {
    console.error(
      `Warning: ${TOKEN_PATH} is readable by group/other users. ` +
        `Run: chmod 600 ${TOKEN_PATH}`
    );
  }
} catch {
  // stat failure is non-fatal; the real read happens in getGmailClient()
}

let gmail = null;

async function getGmailClient() {
  if (gmail) return gmail;

  const raw = await readFile(TOKEN_PATH, "utf8");
  const tokenData = JSON.parse(raw);

  const oauth2 = new google.auth.OAuth2(
    tokenData.client_id,
    tokenData.client_secret
  );

  oauth2.setCredentials({
    access_token: tokenData.token,
    refresh_token: tokenData.refresh_token,
    token_type: "Bearer",
    expiry_date: new Date(tokenData.expiry).getTime(),
  });

  oauth2.on("tokens", async (tokens) => {
    try {
      const current = JSON.parse(await readFile(TOKEN_PATH, "utf8"));
      if (tokens.access_token) current.token = tokens.access_token;
      if (tokens.refresh_token) current.refresh_token = tokens.refresh_token;
      if (tokens.expiry_date)
        current.expiry = new Date(tokens.expiry_date).toISOString();
      await writeFile(TOKEN_PATH, JSON.stringify(current, null, 2), {
        mode: 0o600,
      });
    } catch (e) {
      console.error("Failed to persist refreshed token:", e.message);
    }
  });

  gmail = google.gmail({ version: "v1", auth: oauth2 });
  return gmail;
}

const TOOLS = [
  {
    name: "gmail_modify_thread",
    description:
      "Add and/or remove labels on a Gmail thread. Use this to move emails " +
      "between folders (add destination label + remove INBOX), archive " +
      "(remove INBOX), star, mark read/unread, or apply any label combination.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread ID" },
        addLabelIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Label IDs to add. System labels: INBOX, TRASH, SPAM, STARRED, UNREAD, IMPORTANT. User labels: use gmail_list_labels to find IDs. Note: adding TRASH or SPAM effectively deletes mail (Gmail purges those folders after about 30 days).",
        },
        removeLabelIds: {
          type: "array",
          items: { type: "string" },
          description: "Label IDs to remove.",
        },
      },
      required: ["threadId"],
    },
  },
  {
    name: "gmail_search_threads",
    description:
      "Search Gmail threads using the same query syntax as the Gmail search bar. " +
      "Returns thread IDs, subjects, senders, dates, and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Gmail search query, e.g. "from:notion in:inbox", "subject:invoice after:2026/01/01"',
        },
        maxResults: {
          type: "number",
          description: "Max threads to return (default 20, max 100)",
        },
        pageToken: {
          type: "string",
          description: "Page token for pagination",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gmail_list_labels",
    description:
      "List all Gmail labels with their IDs. Use this to find the label ID " +
      "needed for gmail_modify_thread.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "gmail_list_attachments",
    description:
      "Search Gmail for messages matching a query and list all attachments found. " +
      "Returns attachment metadata (filename, size, MIME type, message ID, attachment ID) " +
      "without downloading. Use this to discover what attachments exist before downloading.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Gmail search query, e.g. "from:docusign has:attachment", "subject:invoice has:attachment filename:pdf"',
        },
        maxResults: {
          type: "number",
          description: "Max messages to search (default 50, max 200)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gmail_download_attachment",
    description:
      "Download a specific attachment by message ID and attachment ID. " +
      "Use gmail_list_attachments first to find the IDs. " +
      "Saves the file to the specified output directory.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "Gmail message ID containing the attachment",
        },
        attachmentId: {
          type: "string",
          description: "Attachment ID from gmail_list_attachments",
        },
        filename: {
          type: "string",
          description: "Filename to save as (from gmail_list_attachments)",
        },
        outputDir: {
          type: "string",
          description:
            "Directory to save the file to. Defaults to ~/Downloads/gmail-attachments/",
        },
      },
      required: ["messageId", "attachmentId", "filename"],
    },
  },
  {
    name: "gmail_download_all_attachments",
    description:
      "Search Gmail for messages matching a query and download ALL attachments found. " +
      "Combines list + download in one step. Creates subdirectories per email subject.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Gmail search query with has:attachment, e.g. "from:docusign has:attachment"',
        },
        outputDir: {
          type: "string",
          description:
            "Directory to save files to. Defaults to ~/Downloads/gmail-attachments/",
        },
        maxResults: {
          type: "number",
          description: "Max messages to search (default 50, max 200)",
        },
      },
      required: ["query"],
    },
  },
];

async function handleModifyThread(args) {
  const client = await getGmailClient();
  const body = {};
  if (args.addLabelIds) body.addLabelIds = args.addLabelIds;
  if (args.removeLabelIds) body.removeLabelIds = args.removeLabelIds;

  const res = await client.users.threads.modify({
    userId: "me",
    id: args.threadId,
    requestBody: body,
  });
  return `Thread ${args.threadId} modified. Labels: ${JSON.stringify(res.data.messages?.[0]?.labelIds || [])}`;
}

async function handleSearchThreads(args) {
  const client = await getGmailClient();
  const res = await client.users.threads.list({
    userId: "me",
    q: args.query,
    maxResults: Math.min(args.maxResults || 20, 100),
    pageToken: args.pageToken,
  });

  const threads = res.data.threads || [];
  if (threads.length === 0)
    return JSON.stringify({ threads: [], nextPageToken: null });

  const detailed = [];
  for (const t of threads) {
    const thread = await client.users.threads.get({
      userId: "me",
      id: t.id,
      format: "METADATA",
      metadataHeaders: ["Subject", "From", "Date"],
    });
    const msg = thread.data.messages?.[0];
    const headers = msg?.payload?.headers || [];
    detailed.push({
      id: t.id,
      subject: headers.find((h) => h.name === "Subject")?.value || "",
      from: headers.find((h) => h.name === "From")?.value || "",
      date: headers.find((h) => h.name === "Date")?.value || "",
      snippet: msg?.snippet || "",
      messageCount: thread.data.messages?.length || 0,
    });
  }

  return JSON.stringify(
    { threads: detailed, nextPageToken: res.data.nextPageToken || null },
    null,
    2
  );
}

async function handleListLabels() {
  const client = await getGmailClient();
  const res = await client.users.labels.list({ userId: "me" });
  const labels = (res.data.labels || []).map((l) => ({
    id: l.id,
    name: l.name,
    type: l.type,
  }));
  return JSON.stringify(labels, null, 2);
}

const DEFAULT_ATTACHMENT_DIR = join(
  homedir(),
  "Downloads", "gmail-attachments"
);

function walkParts(parts, messageId) {
  const attachments = [];
  for (const part of parts || []) {
    const filename = part.filename || "";
    if (filename && part.body?.attachmentId) {
      attachments.push({
        filename,
        attachmentId: part.body.attachmentId,
        messageId,
        size: part.body.size || 0,
        mimeType: part.mimeType || "unknown",
      });
    }
    if (part.parts) {
      attachments.push(...walkParts(part.parts, messageId));
    }
  }
  return attachments;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function handleListAttachments(args) {
  const client = await getGmailClient();
  const maxResults = Math.min(args.maxResults || 50, 200);

  const res = await client.users.messages.list({
    userId: "me",
    q: args.query,
    maxResults,
  });

  const messages = res.data.messages || [];
  if (messages.length === 0)
    return JSON.stringify({ attachments: [], messageCount: 0 });

  const allAttachments = [];
  for (const msgRef of messages) {
    const msg = await client.users.messages.get({
      userId: "me",
      id: msgRef.id,
      format: "FULL",
    });

    const headers = msg.data.payload?.headers || [];
    const subject =
      headers.find((h) => h.name === "Subject")?.value || "No subject";
    const from = headers.find((h) => h.name === "From")?.value || "";
    const date = headers.find((h) => h.name === "Date")?.value || "";

    const parts = msg.data.payload?.parts || [];
    const attachments = walkParts(parts, msgRef.id);

    for (const att of attachments) {
      allAttachments.push({
        ...att,
        subject,
        from,
        date,
        sizeHuman: formatSize(att.size),
      });
    }
  }

  return JSON.stringify(
    { attachments: allAttachments, messageCount: messages.length },
    null,
    2
  );
}

async function handleDownloadAttachment(args) {
  const client = await getGmailClient();
  const outputDir = args.outputDir || DEFAULT_ATTACHMENT_DIR;

  await mkdir(outputDir, { recursive: true });

  const att = await client.users.messages.attachments.get({
    userId: "me",
    id: args.attachmentId,
    messageId: args.messageId,
  });

  const data = Buffer.from(att.data.data, "base64url");

  // Attachment filenames come from email senders, so sanitise before joining
  // so a crafted name (e.g. "../../.ssh/config") cannot escape outputDir.
  const safeName =
    basename(args.filename).replace(/[/\\\0]/g, "_").replace(/^\.+/, "_") ||
    "attachment";

  // Deduplicate filename
  let filepath = join(outputDir, safeName);
  let counter = 1;
  const ext = safeName.includes(".") ? "." + safeName.split(".").pop() : "";
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  while (existsSync(filepath)) {
    filepath = join(outputDir, `${stem}_${counter}${ext}`);
    counter++;
  }

  // Belt and braces: the final path must stay inside outputDir.
  if (!resolve(filepath).startsWith(resolve(outputDir) + sep)) {
    throw new Error(`Refusing to write outside output directory: ${filepath}`);
  }

  await writeFile(filepath, data);
  return `Downloaded: ${basename(filepath)} (${formatSize(data.length)}) → ${filepath}`;
}

async function handleDownloadAllAttachments(args) {
  const client = await getGmailClient();
  const outputDir = args.outputDir || DEFAULT_ATTACHMENT_DIR;
  const maxResults = Math.min(args.maxResults || 50, 200);

  await mkdir(outputDir, { recursive: true });

  const res = await client.users.messages.list({
    userId: "me",
    q: args.query,
    maxResults,
  });

  const messages = res.data.messages || [];
  if (messages.length === 0) return "No messages found matching query.";

  const results = [];
  let totalDownloaded = 0;

  for (const msgRef of messages) {
    const msg = await client.users.messages.get({
      userId: "me",
      id: msgRef.id,
      format: "FULL",
    });

    const headers = msg.data.payload?.headers || [];
    const subject =
      headers.find((h) => h.name === "Subject")?.value || "No subject";

    const parts = msg.data.payload?.parts || [];
    const attachments = walkParts(parts, msgRef.id);

    if (attachments.length === 0) continue;

    // Create subdirectory based on sanitised subject
    const safeSubject =
      subject
        .replace(/[<>:"/\\|?*\0]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^\.+/, "") // a subject of ".." must not resolve to the parent dir
        .slice(0, 80) || "untitled";
    const subDir = join(outputDir, safeSubject);
    await mkdir(subDir, { recursive: true });

    for (const att of attachments) {
      try {
        const downloaded = await handleDownloadAttachment({
          messageId: att.messageId,
          attachmentId: att.attachmentId,
          filename: att.filename,
          outputDir: subDir,
        });
        results.push(downloaded);
        totalDownloaded++;
      } catch (err) {
        results.push(
          `FAILED: ${att.filename} from "${subject}": ${err.message}`
        );
      }
    }
  }

  return `Downloaded ${totalDownloaded} attachments from ${messages.length} messages.\n\n${results.join("\n")}`;
}

const server = new Server(
  { name: "gmail-writer", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    switch (name) {
      case "gmail_modify_thread":
        result = await handleModifyThread(args);
        break;
      case "gmail_search_threads":
        result = await handleSearchThreads(args);
        break;
      case "gmail_list_labels":
        result = await handleListLabels();
        break;
      case "gmail_list_attachments":
        result = await handleListAttachments(args);
        break;
      case "gmail_download_attachment":
        result = await handleDownloadAttachment(args);
        break;
      case "gmail_download_all_attachments":
        result = await handleDownloadAllAttachments(args);
        break;
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes("invalid_grant") || msg.includes("Token has been expired")) {
      return {
        content: [
          {
            type: "text",
            text:
              "Gmail token expired and could not be refreshed. Re-run the OAuth flow:\n" +
              "  uv run --with google-auth-oauthlib oauth_bootstrap.py " +
              "client_secret.json (see README)",
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
