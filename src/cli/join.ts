#!/usr/bin/env node
/**
 * CLI: Join a Copy group channel via invite link.
 *
 * Usage: npm run join -- <invite-url>
 *
 * Accepts:
 *   - Full URL: https://getcopy.app/join/{token}/{base64url_channelSecret}
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadKeypair } from "../copy/storage.js";
import { loadOrAuthenticate } from "../copy/auth.js";
import { joinGroupFromInvite } from "../copy/join.js";
import { DEFAULT_COPY_API_URL } from "../types.js";

const API_URL = process.env.COPY_API_URL ?? DEFAULT_COPY_API_URL;
const DATA_DIR = process.env.COPY_DATA_DIR ?? join(homedir(), ".openclaw", "extensions", "copy", "data");

async function main() {
  const input = process.argv[2];

  if (!input) {
    console.error("Usage: npm run join -- <invite-url>");
    console.error('Example: npm run join -- "https://getcopy.app/join/TOKEN/SECRET"');
    process.exit(1);
  }

  console.log("OpenClaw Copy Plugin — Join Group");
  console.log(`API: ${API_URL}`);
  console.log("");

  // Load keypair
  const keypair = await loadKeypair(DATA_DIR);
  if (!keypair) {
    console.error("No keypair found. Run 'npm run register' first.");
    process.exit(1);
  }

  // Ensure valid session
  const session = await loadOrAuthenticate(
    API_URL,
    DATA_DIR,
    keypair.signingPublicKey,
    keypair.signingPrivateKey,
  );
  console.log(`Authenticated as: ${session.userId}`);
  console.log("");

  // Join group
  console.log("Joining group channel...");
  const { channelId, members } = await joinGroupFromInvite(API_URL, DATA_DIR, input, keypair);

  console.log("");
  console.log("Joined successfully!");
  console.log(`  Channel ID: ${channelId}`);
  console.log(`  Members:    ${members.length}`);
  for (const m of members) {
    console.log(`    - ${m.displayName ?? m.userId.slice(0, 8)}...`);
  }
  console.log("");
  console.log("Restart the OpenClaw gateway to connect to this group channel.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
