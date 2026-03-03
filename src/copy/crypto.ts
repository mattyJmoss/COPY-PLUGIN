/**
 * Crypto helpers using libsodium-wrappers.
 *
 * Key pairs used by Copy:
 *  - Ed25519 (signing): for authentication challenge/verify + group message signing
 *  - X25519 (box): for encrypting/decrypting pairwise audio messages
 *
 * Pairwise: crypto_box (X25519 + XSalsa20-Poly1305)
 * Group: crypto_secretbox (ChaCha20-Poly1305) + Ed25519 signatures
 *   - BLAKE2b KDF derives symmetric key from channel secret (context: "COPYGRPK")
 *   - crypto_box_seal for anonymous key distribution to members
 */

import sodium from "libsodium-wrappers";
import type { Keypair } from "../types.js";

let _ready = false;

export async function ensureSodium(): Promise<void> {
  if (!_ready) {
    await sodium.ready;
    _ready = true;
  }
}

export async function generateKeypair(): Promise<Keypair> {
  await ensureSodium();

  const signingKp = sodium.crypto_sign_keypair();
  const boxKp = sodium.crypto_box_keypair();

  return {
    signingPublicKey: sodium.to_base64(signingKp.publicKey, sodium.base64_variants.ORIGINAL),
    signingPrivateKey: sodium.to_base64(signingKp.privateKey, sodium.base64_variants.ORIGINAL),
    publicKey: sodium.to_base64(boxKp.publicKey, sodium.base64_variants.ORIGINAL),
    privateKey: sodium.to_base64(boxKp.privateKey, sodium.base64_variants.ORIGINAL),
  };
}

/** Sign a nonce (base64) with the Ed25519 private key. */
export async function signNonce(
  nonceBase64: string,
  signingPrivateKeyBase64: string,
): Promise<string> {
  await ensureSodium();

  const nonceBytes = sodium.from_base64(nonceBase64, sodium.base64_variants.ORIGINAL);
  const privKeyBytes = sodium.from_base64(signingPrivateKeyBase64, sodium.base64_variants.ORIGINAL);

  const signature = sodium.crypto_sign_detached(nonceBytes, privKeyBytes);
  return sodium.to_base64(signature, sodium.base64_variants.ORIGINAL);
}

/** Decrypt raw audio bytes using crypto_box_open_easy. */
export async function decryptAudioRaw(
  ciphertext: Uint8Array,
  nonceBase64: string,
  friendPublicKeyBase64: string,
  myPrivateKeyBase64: string,
): Promise<Uint8Array> {
  await ensureSodium();

  const nonce = sodium.from_base64(nonceBase64, sodium.base64_variants.ORIGINAL);
  const friendPubKey = sodium.from_base64(friendPublicKeyBase64, sodium.base64_variants.ORIGINAL);
  const myPrivKey = sodium.from_base64(myPrivateKeyBase64, sodium.base64_variants.ORIGINAL);

  return sodium.crypto_box_open_easy(ciphertext, nonce, friendPubKey, myPrivKey);
}

/** Decrypt base64-encoded audio using crypto_box_open_easy. */
export async function decryptAudio(
  ciphertextBase64: string,
  nonceBase64: string,
  friendPublicKeyBase64: string,
  myPrivateKeyBase64: string,
): Promise<Uint8Array> {
  await ensureSodium();

  const ciphertext = sodium.from_base64(ciphertextBase64, sodium.base64_variants.ORIGINAL);
  const nonce = sodium.from_base64(nonceBase64, sodium.base64_variants.ORIGINAL);
  const friendPubKey = sodium.from_base64(friendPublicKeyBase64, sodium.base64_variants.ORIGINAL);
  const myPrivKey = sodium.from_base64(myPrivateKeyBase64, sodium.base64_variants.ORIGINAL);

  return sodium.crypto_box_open_easy(ciphertext, nonce, friendPubKey, myPrivKey);
}

// ── Group Crypto ──

/** Derive a symmetric group key from a channel secret using BLAKE2b KDF. */
export async function deriveGroupKey(channelSecret: Uint8Array): Promise<Uint8Array> {
  await ensureSodium();
  const context = new TextEncoder().encode("COPYGRPK");
  return sodium.crypto_generichash(32, context, channelSecret);
}

/** Encrypt audio bytes for a group channel using crypto_secretbox + Ed25519 signature. */
export async function encryptGroupAudio(
  plaintext: Uint8Array,
  groupKey: Uint8Array,
  signingPrivateKeyBase64: string,
): Promise<{ ciphertext: string; nonce: string; signature: string }> {
  await ensureSodium();

  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, groupKey);

  // Sign (nonce || ciphertext) for sender authentication
  const toSign = new Uint8Array(nonce.length + ciphertext.length);
  toSign.set(nonce, 0);
  toSign.set(ciphertext, nonce.length);

  const privKey = sodium.from_base64(signingPrivateKeyBase64, sodium.base64_variants.ORIGINAL);
  const sig = sodium.crypto_sign_detached(toSign, privKey);

  return {
    ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    signature: sodium.to_base64(sig, sodium.base64_variants.ORIGINAL),
  };
}

/** Decrypt group audio (crypto_secretbox) and verify Ed25519 signature. */
export async function decryptGroupAudio(
  ciphertextBase64: string,
  nonceBase64: string,
  groupKey: Uint8Array,
  signatureBase64: string,
  senderSigningKeyBase64: string,
): Promise<Uint8Array> {
  await ensureSodium();

  const ciphertext = sodium.from_base64(ciphertextBase64, sodium.base64_variants.ORIGINAL);
  const nonce = sodium.from_base64(nonceBase64, sodium.base64_variants.ORIGINAL);
  const sig = sodium.from_base64(signatureBase64, sodium.base64_variants.ORIGINAL);
  const senderPubKey = sodium.from_base64(senderSigningKeyBase64, sodium.base64_variants.ORIGINAL);

  // Verify signature over (nonce || ciphertext) before decrypting
  const toVerify = new Uint8Array(nonce.length + ciphertext.length);
  toVerify.set(nonce, 0);
  toVerify.set(ciphertext, nonce.length);

  const valid = sodium.crypto_sign_verify_detached(sig, toVerify, senderPubKey);
  if (!valid) {
    throw new Error("Group message signature verification failed");
  }

  return sodium.crypto_secretbox_open_easy(ciphertext, nonce, groupKey);
}

/** Decrypt raw group audio bytes (crypto_secretbox) and verify Ed25519 signature. */
export async function decryptGroupAudioRaw(
  ciphertext: Uint8Array,
  nonceBase64: string,
  groupKey: Uint8Array,
  signatureBase64: string,
  senderSigningKeyBase64: string,
): Promise<Uint8Array> {
  await ensureSodium();

  const nonce = sodium.from_base64(nonceBase64, sodium.base64_variants.ORIGINAL);
  const sig = sodium.from_base64(signatureBase64, sodium.base64_variants.ORIGINAL);
  const senderPubKey = sodium.from_base64(senderSigningKeyBase64, sodium.base64_variants.ORIGINAL);

  // Verify signature over (nonce || ciphertext)
  const toVerify = new Uint8Array(nonce.length + ciphertext.length);
  toVerify.set(nonce, 0);
  toVerify.set(ciphertext, nonce.length);

  const valid = sodium.crypto_sign_verify_detached(sig, toVerify, senderPubKey);
  if (!valid) {
    throw new Error("Group message signature verification failed");
  }

  return sodium.crypto_secretbox_open_easy(ciphertext, nonce, groupKey);
}

/** Seal a channel secret for a recipient using crypto_box_seal (anonymous encryption). */
export async function sealChannelSecret(
  secret: Uint8Array,
  recipientX25519PublicKeyBase64: string,
): Promise<string> {
  await ensureSodium();
  const recipientKey = sodium.from_base64(recipientX25519PublicKeyBase64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(secret, recipientKey);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

/** Open a sealed channel secret using our X25519 keypair. */
export async function openSealedSecret(
  sealedBase64: string,
  myX25519PublicKeyBase64: string,
  myX25519PrivateKeyBase64: string,
): Promise<Uint8Array> {
  await ensureSodium();
  const sealed = sodium.from_base64(sealedBase64, sodium.base64_variants.ORIGINAL);
  const pubKey = sodium.from_base64(myX25519PublicKeyBase64, sodium.base64_variants.ORIGINAL);
  const privKey = sodium.from_base64(myX25519PrivateKeyBase64, sodium.base64_variants.ORIGINAL);
  return sodium.crypto_box_seal_open(sealed, pubKey, privKey);
}

// ── Pairwise Crypto ──

/** Encrypt audio bytes using crypto_box_easy. */
export async function encryptAudio(
  plaintext: Uint8Array,
  friendPublicKeyBase64: string,
  myPrivateKeyBase64: string,
): Promise<{ ciphertext: string; nonce: string }> {
  await ensureSodium();

  const friendPubKey = sodium.from_base64(friendPublicKeyBase64, sodium.base64_variants.ORIGINAL);
  const myPrivKey = sodium.from_base64(myPrivateKeyBase64, sodium.base64_variants.ORIGINAL);
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const ciphertext = sodium.crypto_box_easy(plaintext, nonce, friendPubKey, myPrivKey);

  return {
    ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
  };
}
