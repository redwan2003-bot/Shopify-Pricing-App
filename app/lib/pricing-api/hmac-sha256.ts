/**
 * A self-contained, synchronous SHA-256 / HMAC-SHA256 implementation (FIPS 180-4 /
 * RFC 2104), with no dependency on Node's `crypto` module or the Web Crypto
 * (`crypto.subtle`) API.
 *
 * Why this exists instead of just calling `crypto.createHmac`: this exact file is
 * duplicated verbatim in `extensions/imprintid-cart-pricing/src/hmac-sha256.ts`, which
 * runs inside the Shopify Function's WASM sandbox — a constrained JS runtime that
 * cannot be assumed to expose Node's `crypto` module, and whose `cartTransformRun`
 * export is synchronous (returns a plain object, not a Promise), which rules out
 * `crypto.subtle` even where it might exist, since every one of its operations is
 * async. Rather than have the server sign with one implementation and the Function
 * verify with another (a real risk of subtle incompatibility), both sides use this
 * identical, dependency-free implementation — see `cart-signature.test.ts` for a
 * known-answer cross-check against Node's own `crypto.createHmac` output, which is
 * what actually proves this implementation is correct, not just "consistent with
 * itself."
 *
 * If this file is ever changed, the copy in
 * `extensions/imprintid-cart-pricing/src/hmac-sha256.ts` must be updated identically —
 * they are intentionally not imported from a shared location (see that file's own
 * comment for why: Shopify Function builds are expected to be self-contained within
 * the extension directory).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Pads a message per FIPS 180-4 §5.1.1 and returns the SHA-256 digest as 32 raw bytes. */
export function sha256(message: Uint8Array): Uint8Array {
  const bitLength = message.length * 8;
  const paddedLength = (((message.length + 8) >> 6) + 1) << 6; // next multiple of 64 with room for length
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  // 64-bit big-endian bit length in the final 8 bytes (bitLength fits in 32 bits for
  // any payload this system ever signs, so the high 4 bytes are always zero).
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const h = H0.slice();
  const w = new Uint32Array(64);

  for (let chunkStart = 0; chunkStart < padded.length; chunkStart += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(chunkStart + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const temp1 = (hh! + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (S0 + maj) >>> 0;

      hh = g; g = f; f = e;
      e = (d! + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0]! + a!) >>> 0;
    h[1] = (h[1]! + b!) >>> 0;
    h[2] = (h[2]! + c!) >>> 0;
    h[3] = (h[3]! + d!) >>> 0;
    h[4] = (h[4]! + e!) >>> 0;
    h[5] = (h[5]! + f!) >>> 0;
    h[6] = (h[6]! + g!) >>> 0;
    h[7] = (h[7]! + hh!) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) digestView.setUint32(i * 4, h[i]!, false);
  return digest;
}

const BLOCK_SIZE = 64;

/** HMAC-SHA256 per RFC 2104. Returns the raw 32-byte MAC. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  let normalizedKey = key;
  if (normalizedKey.length > BLOCK_SIZE) {
    normalizedKey = sha256(normalizedKey);
  }
  if (normalizedKey.length < BLOCK_SIZE) {
    const padded = new Uint8Array(BLOCK_SIZE);
    padded.set(normalizedKey);
    normalizedKey = padded;
  }

  const ipad = new Uint8Array(BLOCK_SIZE);
  const opad = new Uint8Array(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i++) {
    ipad[i] = normalizedKey[i]! ^ 0x36;
    opad[i] = normalizedKey[i]! ^ 0x5c;
  }

  const inner = sha256(concatBytes(ipad, message));
  return sha256(concatBytes(opad, inner));
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const HEX_CHARS = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    out += HEX_CHARS[byte >> 4] + HEX_CHARS[byte & 0x0f];
  }
  return out;
}

export function utf8ToBytes(text: string): Uint8Array {
  // TextEncoder is available in both Node and the Shopify Function JS runtime
  // (it's part of the JS spec's host-provided globals both environments implement).
  return new TextEncoder().encode(text);
}

/** Constant-time byte comparison — avoids leaking timing information about how much
 * of a signature matched, which a naive `===`/loop-with-early-return would. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Signs `message` with `secret`, returning a lowercase hex HMAC-SHA256 digest. */
export function signHex(secret: string, message: string): string {
  return bytesToHex(hmacSha256(utf8ToBytes(secret), utf8ToBytes(message)));
}
