#!/usr/bin/env node
/**
 * Batch-label emails as "for review-to be deleted".
 * Uses the same OAuth token as the gmail-writer MCP server.
 *
 * Run: node ./label-for-deletion.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { google } from "googleapis";

const TOKEN_PATH = join(homedir(), ".gmail_token.json");
// The Gmail label to apply (find IDs with gmail_list_labels).
const LABEL_ID = process.env.GMAIL_DELETION_LABEL_ID;
if (!LABEL_ID) {
  console.error("Set GMAIL_DELETION_LABEL_ID to the label ID to apply.");
  process.exit(1);
}

async function getGmailClient() {
  const raw = await readFile(TOKEN_PATH, "utf8");
  const tokenData = JSON.parse(raw);
  const oauth2 = new google.auth.OAuth2(tokenData.client_id, tokenData.client_secret);
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
      if (tokens.expiry_date) current.expiry = new Date(tokens.expiry_date).toISOString();
      await writeFile(TOKEN_PATH, JSON.stringify(current, null, 2), { mode: 0o600 });
    } catch (e) { console.error("Token persist error:", e.message); }
  });
  return google.gmail({ version: "v1", auth: oauth2 });
}

// EXAMPLE queries: replace with your own. Each is a standard Gmail
// search; every matching thread gets the label for review before you
// bulk-delete from the Gmail UI.
const QUERIES = [
  // Old marketing/promo mail
  'in:inbox (from:noreply OR from:newsletter) subject:(sale OR offer OR unsubscribe) older_than:30d',
  // Social media notifications
  'in:inbox from:(facebookmail.com OR linkedin.com OR x.com) older_than:7d',
  // Delivery notifications older than a month
  'in:inbox subject:("your order" OR "has shipped" OR "delivery update") older_than:30d',
];

async function collectThreadIds(gmail) {
  const allThreadIds = new Set();

  for (const query of QUERIES) {
    let pageToken = undefined;
    let queryTotal = 0;
    do {
      try {
        const res = await gmail.users.threads.list({
          userId: "me",
          q: query,
          maxResults: 100,
          pageToken,
        });
        const threads = res.data.threads || [];
        for (const t of threads) allThreadIds.add(t.id);
        queryTotal += threads.length;
        pageToken = res.data.nextPageToken;
      } catch (e) {
        console.error(`  Error: ${e.message}`);
        pageToken = undefined;
      }
    } while (pageToken);

    const shortQuery = query.length > 80 ? query.substring(0, 80) + "..." : query;
    console.log(`  [${queryTotal} threads] ${shortQuery}`);
  }

  return allThreadIds;
}

async function main() {
  console.log("Gmail Batch Labeller: 'for review-to be deleted'");
  console.log("=".repeat(50));

  const gmail = await getGmailClient();
  console.log("Authenticated.\n");

  console.log("Phase 1: Collecting thread IDs...\n");
  const threadIds = await collectThreadIds(gmail);
  console.log(`\nTotal unique threads to label: ${threadIds.size}\n`);

  if (threadIds.size === 0) {
    console.log("Nothing to label. Done.");
    return;
  }

  console.log("Phase 2: Applying label...\n");
  let success = 0;
  let errors = 0;
  const arr = [...threadIds];

  for (let i = 0; i < arr.length; i++) {
    try {
      await gmail.users.threads.modify({
        userId: "me",
        id: arr[i],
        requestBody: { addLabelIds: [LABEL_ID] },
      });
      success++;
    } catch (e) {
      errors++;
      console.error(`  Failed ${arr[i]}: ${e.message}`);
    }

    if ((i + 1) % 20 === 0 || i === arr.length - 1) {
      console.log(`  Progress: ${i + 1}/${arr.length} (${success} labelled, ${errors} errors)`);
    }
  }

  console.log(`\nDone! Labelled ${success} threads. Errors: ${errors}.`);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
