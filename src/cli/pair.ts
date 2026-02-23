#!/usr/bin/env node
/**
 * CLI: Redeem a Copy pair link to connect with a friend.
 *
 * Usage: openclaw copy pair <pair-link-or-token>
 *
 * Accepts:
 *   - Full URL:  https://walkie-talkie-api.matt8066.workers.dev/pair/abc123def456...
 *   - Just path: /pair/abc123def456...
 *   - Just token: abc123def456...
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadKeypair, addChannel } from "../copy/storage.js";
import { loadOrAuthenticate } from "../copy/auth.js";
import { redeemPairToken } from "../copy/api.js";

const API_URL = process.env.COPY_API_URL ?? "https://walkie-talkie-api.matt8066.workers.dev";
const DATA_DIR = process.env.COPY_DATA_DIR ?? join(homedir(), ".openclaw", "extensions", "copy", "data");

function extractToken(input: string): string | null {
  input = input.trim();

  // Full URL or path with /pair/TOKEN
  const match = input.match(/\/pair\/([0-9a-f]{32})/i);
  if (match) return match[1];

  // Just the token itself (32 hex chars)
  if (/^[0-9a-f]{32}$/i.test(input)) return input;

  return null;
}

async function main() {
  const input = process.argv[2];

  if (!input) {
    console.error("Usage: openclaw copy pair <pair-link-or-token>");
    console.error("Example: openclaw copy pair https://walkie-talkie-api.matt8066.workers.dev/pair/abc123...");
    process.exit(1);
  }

  console.log("OpenClaw Copy Plugin — Pairing");
  console.log(`API: ${API_URL}`);
  console.log("");

  const token = extractToken(input);
  if (!token) {
    console.error("Could not extract pair token from:", input);
    console.error("Expected a 32-character hex token or URL containing /pair/<token>");
    process.exit(1);
  }

  console.log(`Pair token: ${token}`);
  console.log("");

  // Load keypair
  const keypair = await loadKeypair(DATA_DIR);
  if (!keypair) {
    console.error("No keypair found. Run 'openclaw copy register' first.");
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

  // Redeem the pair token
  console.log("Redeeming pair token...");
  const result = await redeemPairToken(API_URL, token, 1);

  if (!result.ok) {
    console.error("Pairing failed:", result.error);

    if (result.error?.includes("already redeemed")) {
      console.error("The link was already used. Ask your friend to generate a new one.");
    } else if (result.error?.includes("expired")) {
      console.error("The link has expired. Ask your friend to generate a new one.");
    } else if (result.error?.includes("yourself")) {
      console.error("Cannot pair with yourself.");
    }

    process.exit(1);
  }

  const { channelId, inviterUserId, inviterPublicKey, inviterDisplayName } = result.data!;

  console.log("Paired successfully!");
  console.log(`  Channel ID:    ${channelId}`);
  console.log(`  Friend:        ${inviterDisplayName ?? "Unknown"} (${inviterUserId.slice(0, 8)}...)`);
  console.log(`  Friend pubkey: ${inviterPublicKey.slice(0, 12)}...`);
  console.log("");

  // Save channel info
  await addChannel(DATA_DIR, {
    channelId,
    friendUserId: inviterUserId,
    friendPublicKey: inviterPublicKey,
    friendDisplayName: inviterDisplayName ?? undefined,
    pairedAt: new Date().toISOString(),
  });

  console.log(`Channel info saved.`);
  console.log("");
  console.log(`Now paired with ${inviterDisplayName ?? inviterUserId}.`);
  console.log("Add this to your OpenClaw config and restart the gateway:");
  console.log("");
  console.log("  channels:");
  console.log("    copy:");
  console.log("      enabled: true");
  console.log(`      apiUrl: "${API_URL}"`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
