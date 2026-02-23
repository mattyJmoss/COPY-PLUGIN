#!/usr/bin/env node
/**
 * CLI: Generate keypair and register with the Copy backend.
 *
 * Usage: openclaw copy register
 *
 * This only needs to run ONCE. The keypair is stored in
 * ~/.openclaw/extensions/copy/data/keypair.json (chmod 600).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { generateKeypair } from "../copy/crypto.js";
import { saveKeypair, loadKeypair } from "../copy/storage.js";
import { register, setSessionToken } from "../copy/api.js";
import { authenticate } from "../copy/auth.js";
import { updateProfile } from "../copy/api.js";

const API_URL = process.env.COPY_API_URL ?? "https://walkie-talkie-api.matt8066.workers.dev";
const DATA_DIR = process.env.COPY_DATA_DIR ?? join(homedir(), ".openclaw", "extensions", "copy", "data");
const DISPLAY_NAME = process.env.COPY_DISPLAY_NAME ?? "OpenClaw";

async function main() {
  console.log("OpenClaw Copy Plugin — Registration");
  console.log(`API: ${API_URL}`);
  console.log(`Data: ${DATA_DIR}`);
  console.log("");

  // Check if already registered
  const existing = await loadKeypair(DATA_DIR);
  if (existing) {
    console.log("Keypair already exists.");
    console.log("To re-register, delete keypair.json and session.json from:");
    console.log(`  ${DATA_DIR}`);
    console.log("WARNING: This will create a new identity.");
    process.exit(0);
  }

  // Generate fresh keypair
  console.log("Generating Ed25519 (signing) + X25519 (encryption) keypair...");
  const keypair = await generateKeypair();

  console.log(`  Ed25519 public: ${keypair.signingPublicKey.slice(0, 12)}...`);
  console.log(`  X25519 public:  ${keypair.publicKey.slice(0, 12)}...`);
  console.log("");

  // Register with Copy backend
  console.log("Registering with Copy API...");
  const result = await register(API_URL, keypair.publicKey, keypair.signingPublicKey);

  if (!result.ok) {
    if (result.error === "Device already registered") {
      console.log("Server says device already registered with this keypair.");
      console.log("Saving keypair anyway so you can authenticate with it.");
      await saveKeypair(DATA_DIR, keypair);
    } else {
      console.error("Registration failed:", result.error);
      process.exit(1);
    }
  } else {
    const userId = result.data!.userId;
    console.log(`Registered! userId: ${userId}`);
    await saveKeypair(DATA_DIR, keypair);
    console.log(`Keypair saved to ${DATA_DIR}/keypair.json`);
  }

  // Authenticate and set display name
  console.log("");
  console.log("Authenticating...");
  const session = await authenticate(
    API_URL,
    DATA_DIR,
    keypair.signingPublicKey,
    keypair.signingPrivateKey,
  );

  console.log(`Setting display name to "${DISPLAY_NAME}"...`);
  const profileRes = await updateProfile(API_URL, { displayName: DISPLAY_NAME });
  if (profileRes.ok) {
    console.log(`Display name set to: ${DISPLAY_NAME}`);
  } else {
    console.log(`Failed to set display name: ${profileRes.error}`);
  }

  console.log("");
  console.log("Registration complete! Next steps:");
  console.log("  1. Have a friend send you a Copy pair link");
  console.log("  2. Run: openclaw copy pair <link>");
  console.log("  3. Configure channels.copy in your OpenClaw config");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
