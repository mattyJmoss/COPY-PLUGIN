#!/usr/bin/env node
/**
 * CLI: Show Copy plugin status — keypair, session, paired channels.
 *
 * Usage: openclaw copy status
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadKeypair, loadSession, loadChannels } from "../copy/storage.js";
import { getProfile, setSessionToken } from "../copy/api.js";
import { DEFAULT_COPY_API_URL } from "../types.js";

const API_URL = process.env.COPY_API_URL ?? DEFAULT_COPY_API_URL;
const DATA_DIR = process.env.COPY_DATA_DIR ?? join(homedir(), ".openclaw", "extensions", "copy", "data");

async function main() {
  console.log("OpenClaw Copy Plugin — Status");
  console.log(`API:  ${API_URL}`);
  console.log(`Data: ${DATA_DIR}`);
  console.log("");

  // Keypair
  const keypair = await loadKeypair(DATA_DIR);
  if (!keypair) {
    console.log("Keypair:  NOT REGISTERED");
    console.log("  Run: openclaw copy register");
    return;
  }
  console.log(`Keypair:  OK`);
  console.log(`  Ed25519: ${keypair.signingPublicKey.slice(0, 16)}...`);
  console.log(`  X25519:  ${keypair.publicKey.slice(0, 16)}...`);

  // Session
  const session = await loadSession(DATA_DIR);
  if (!session) {
    console.log("Session:  EXPIRED or missing");
    console.log("  Session will auto-refresh when the plugin starts.");
  } else {
    const expiresAt = new Date(session.expiresAt * 1000);
    const remaining = Math.max(0, session.expiresAt - Math.floor(Date.now() / 1000));
    const minutes = Math.floor(remaining / 60);
    console.log(`Session:  VALID (${minutes} min remaining)`);
    console.log(`  User ID: ${session.userId}`);
    console.log(`  Expires: ${expiresAt.toISOString()}`);

    // Try to fetch profile
    setSessionToken(session.token);
    try {
      const profileRes = await getProfile(API_URL);
      if (profileRes.ok && profileRes.data?.profile) {
        const p = profileRes.data.profile;
        console.log(`  Display: ${p.displayName ?? "(none)"}`);
      }
    } catch {
      // Profile fetch is optional
    }
  }

  // Channels
  const { channels } = await loadChannels(DATA_DIR);
  console.log("");
  if (channels.length === 0) {
    console.log("Channels: NONE");
    console.log("  Run: openclaw copy pair <link>");
  } else {
    console.log(`Channels: ${channels.length} paired`);
    for (const ch of channels) {
      const name = ch.friendDisplayName ?? ch.friendUserId.slice(0, 8);
      console.log(`  - ${name}`);
      console.log(`    ID:     ${ch.channelId}`);
      console.log(`    Pubkey: ${ch.friendPublicKey.slice(0, 16)}...`);
      console.log(`    Paired: ${ch.pairedAt}`);
    }
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
