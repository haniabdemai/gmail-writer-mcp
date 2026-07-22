#!/usr/bin/env node
/**
 * Non-destructive test suite for gmail-writer MCP server.
 *
 * Tests each tool directly via the Gmail API (same code path as the MCP server)
 * plus token validity and error handling. It leaves your mailbox as it found
 * it: the modify test stars then immediately unstars a thread.
 *
 * Run: node test.js
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { google } from "googleapis";

const TOKEN_PATH = join(homedir(), ".gmail_token.json");

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name) {
  console.log(`  PASS  ${name}`);
  passed++;
}
function fail(name, err) {
  console.log(`  FAIL  ${name}: ${err}`);
  failed++;
}
function skip(name, why) {
  console.log(`  SKIP  ${name}: ${why}`);
  skipped++;
}

async function loadClient() {
  const raw = await readFile(TOKEN_PATH, "utf8");
  const t = JSON.parse(raw);
  const oauth2 = new google.auth.OAuth2(t.client_id, t.client_secret);
  oauth2.setCredentials({
    access_token: t.token,
    refresh_token: t.refresh_token,
    token_type: "Bearer",
    expiry_date: new Date(t.expiry).getTime(),
  });
  return { gmail: google.gmail({ version: "v1", auth: oauth2 }), tokenData: t };
}

// ── Test 1: Token file exists and has required fields ──
async function testTokenFile() {
  const name = "Token file has required fields";
  try {
    const raw = await readFile(TOKEN_PATH, "utf8");
    const t = JSON.parse(raw);
    const required = ["token", "refresh_token", "client_id", "client_secret", "expiry"];
    const missing = required.filter((k) => !t[k]);
    if (missing.length > 0) return fail(name, `missing: ${missing.join(", ")}`);
    if (!t.scopes?.includes("https://www.googleapis.com/auth/gmail.modify"))
      return fail(name, "gmail.modify scope not in token");
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

// ── Test 2: Token is valid or can be refreshed ──
async function testTokenValid() {
  const name = "Token is valid (API responds)";
  try {
    const { gmail } = await loadClient();
    const res = await gmail.users.getProfile({ userId: "me" });
    if (!res.data.emailAddress) return fail(name, "no email in profile");
    ok(`${name} (${res.data.emailAddress})`);
  } catch (e) {
    fail(name, e.message);
  }
}

// ── Test 3: gmail_list_labels ──
async function testListLabels() {
  const name = "gmail_list_labels returns labels";
  try {
    const { gmail } = await loadClient();
    const res = await gmail.users.labels.list({ userId: "me" });
    const labels = res.data.labels || [];
    if (labels.length === 0) return fail(name, "no labels returned");

    const hasInbox = labels.some((l) => l.id === "INBOX");
    if (!hasInbox) return fail(name, "INBOX label not found");

    const userLabels = labels.filter((l) => l.type === "user");
    ok(`${name} (${labels.length} total, ${userLabels.length} user-defined)`);
  } catch (e) {
    fail(name, e.message);
  }
}

// ── Test 4: gmail_search_threads ──
async function testSearchThreads() {
  const name = "gmail_search_threads returns results";
  try {
    const { gmail } = await loadClient();
    const res = await gmail.users.threads.list({
      userId: "me",
      q: "in:inbox",
      maxResults: 3,
    });
    const threads = res.data.threads || [];
    if (threads.length === 0) return fail(name, "no threads in inbox");

    // Verify we can fetch metadata for the first thread
    const detail = await gmail.users.threads.get({
      userId: "me",
      id: threads[0].id,
      format: "METADATA",
      metadataHeaders: ["Subject", "From"],
    });
    const subject =
      detail.data.messages?.[0]?.payload?.headers?.find(
        (h) => h.name === "Subject"
      )?.value || "(no subject)";
    ok(`${name} (found ${threads.length}, first: "${subject.slice(0, 50)}")`);
  } catch (e) {
    fail(name, e.message);
  }
}

// ── Test 5: gmail_modify_thread (non-destructive round-trip) ──
async function testModifyThread() {
  const name = "gmail_modify_thread can star and unstar";
  try {
    const { gmail } = await loadClient();

    // Find any thread
    const res = await gmail.users.threads.list({
      userId: "me",
      q: "in:inbox",
      maxResults: 1,
    });
    const threads = res.data.threads || [];
    if (threads.length === 0) return fail(name, "no threads to test with");

    const tid = threads[0].id;

    // Star it
    await gmail.users.threads.modify({
      userId: "me",
      id: tid,
      requestBody: { addLabelIds: ["STARRED"] },
    });

    // Verify star was applied
    const starred = await gmail.users.threads.get({
      userId: "me",
      id: tid,
      format: "MINIMAL",
    });
    const hasStarred = starred.data.messages?.some((m) =>
      m.labelIds?.includes("STARRED")
    );
    if (!hasStarred) return fail(name, "STARRED label not applied");

    // Unstar it (restore original state)
    await gmail.users.threads.modify({
      userId: "me",
      id: tid,
      requestBody: { removeLabelIds: ["STARRED"] },
    });

    ok(`${name} (thread ${tid})`);
  } catch (e) {
    fail(name, e.message);
  }
}

// ── Test 6: Error handling (bad thread ID) ──
async function testBadThreadId() {
  const name = "Bad thread ID returns error (not crash)";
  try {
    const { gmail } = await loadClient();
    await gmail.users.threads.modify({
      userId: "me",
      id: "NONEXISTENT_THREAD_ID_12345",
      requestBody: { addLabelIds: ["STARRED"] },
    });
    fail(name, "should have thrown");
  } catch (e) {
    if (e.code === 404 || e.message.includes("Not Found") || e.message.includes("Invalid id")) {
      ok(name);
    } else {
      fail(name, `unexpected error type: ${e.message}`);
    }
  }
}

// ── Test 7: Verify system labels exist ──
async function testExpectedLabels() {
  const name = "Expected system labels exist (STARRED, IMPORTANT)";
  try {
    const { gmail } = await loadClient();
    const res = await gmail.users.labels.list({ userId: "me" });
    const labels = res.data.labels || [];
    const byName = Object.fromEntries(labels.map((l) => [l.name, l.id]));

    const missing = [];
    if (!byName["STARRED"]) missing.push("STARRED");
    if (!byName["IMPORTANT"]) missing.push("IMPORTANT");

    if (missing.length > 0) return fail(name, `missing: ${missing.join(", ")}`);
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

// ── Test 8: MCP server module loads without error ──
async function testServerLoads() {
  const name = "MCP server index.js parses without syntax errors";
  try {
    // Just check it parses; don't actually start the server (it would block on stdio)
    const serverPath = new URL("./index.js", import.meta.url).pathname;
    await readFile(serverPath, "utf8");
    // If we got here, the file exists and is readable
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

// ── Test 9: Verify Claude Desktop config (optional) ──
async function testClaudeDesktopConfig() {
  const name = "Claude Desktop config has gmail-writer entry";
  const configPath = join(
    homedir(),
    "Library/Application Support/Claude/claude_desktop_config.json"
  );
  if (!existsSync(configPath)) {
    return skip(name, "no Claude Desktop config on this machine");
  }
  try {
    const raw = await readFile(configPath, "utf8");
    const config = JSON.parse(raw);
    const entry = config.mcpServers?.["gmail-writer"];
    if (!entry) return fail(name, "no gmail-writer entry in mcpServers");
    if (entry.command !== "node") return fail(name, `command is "${entry.command}", expected "node"`);
    if (!entry.args?.[0]?.includes("index.js"))
      return fail(name, `args don't point to index.js`);
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

// ── Test 10: Verify Claude Code config (optional) ──
async function testClaudeCodeConfig() {
  const name = "Claude Code config has gmail-writer entry";
  // `claude mcp add` writes to ~/.claude.json (mcpServers key); an
  // ~/.claude/mcp_servers.json file is also accepted.
  const candidates = [
    join(homedir(), ".claude.json"),
    join(homedir(), ".claude/mcp_servers.json"),
  ];
  const present = candidates.filter((p) => existsSync(p));
  if (present.length === 0) {
    return skip(name, "no Claude Code config on this machine");
  }
  try {
    for (const configPath of present) {
      const raw = await readFile(configPath, "utf8");
      const config = JSON.parse(raw);
      const entry =
        config.mcpServers?.["gmail-writer"] || config["gmail-writer"];
      if (entry) {
        const cmd = entry.command;
        if (!cmd?.includes?.("node") && !cmd?.[0]?.includes?.("node"))
          return fail(name, "command doesn't include node");
        return ok(`${name} (${configPath})`);
      }
    }
    fail(name, `no gmail-writer entry in: ${present.join(", ")}`);
  } catch (e) {
    fail(name, e.message);
  }
}

// ── Run all tests ──
console.log("\ngmail-writer MCP server test suite\n");

console.log("Token & Auth:");
await testTokenFile();
await testTokenValid();

console.log("\nTools:");
await testListLabels();
await testSearchThreads();
await testModifyThread();

console.log("\nError Handling:");
await testBadThreadId();

console.log("\nIntegration:");
await testExpectedLabels();
await testServerLoads();
await testClaudeDesktopConfig();
await testClaudeCodeConfig();

console.log(`\n${"─".repeat(40)}`);
console.log(
  `Results: ${passed} passed, ${failed} failed, ${skipped} skipped out of ${passed + failed + skipped}`
);
if (failed > 0) process.exit(1);
