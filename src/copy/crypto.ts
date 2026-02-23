/**
 * Crypto helpers using libsodium-wrappers.
 *
 * Key pairs used by Copy:
 *  - Ed25519 (signing): for authentication challenge/verify
 *  - X25519 (box): for encrypting/decrypting audio messages
 *
 * Copy uses crypto_box (X25519 + XSalsa20-Poly1305), NOT crypto_secretbox.
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
