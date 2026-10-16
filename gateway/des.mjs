/**
 * DES-ECB 解密（PKCS7），用于解密 queryUserToken 返回的加密手机号。
 *
 * 优先用 Node 原生 crypto（OpenSSL 3 需 --openssl-legacy-provider 启用 DES），
 * 失败时回退到内置纯 JS 实现，因此网关无需任何启动参数与依赖。
 */
import crypto from "node:crypto";

export function decryptDES(b64, keyStr, { raw = false } = {}) {
  const data = Buffer.from(b64, "base64");
  if (data.length === 0 || data.length % 8 !== 0) {
    throw new Error("DES 密文长度非法: " + data.length);
  }
  // 原生路径（auto-padding 已含 PKCS7 去除，不能再手动 unpad）
  try {
    const d = crypto.createDecipheriv("des-ecb", Buffer.from(keyStr, "utf8"), null);
    if (raw) d.setAutoPadding(false);
    const out = Buffer.concat([d.update(data), d.final()]);
    return raw ? out.toString("latin1") : out.toString("utf8");
  } catch (e) {
    if (!/unsupported|ERR_OSS/i.test(String(e))) throw e;
  }
  // 纯 JS 回退
  const keyBytes = Buffer.from(keyStr, "utf8");
  const keys = subkeys(keyBytes).reverse(); // 解密用逆序子密钥
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 8) {
    decryptBlock(data.subarray(i, i + 8), keys).copy(out, i);
  }
  return raw ? out.toString("latin1") : unpad(out).toString("utf8");
}

function unpad(buf) {
  const n = buf[buf.length - 1];
  if (n < 1 || n > 8) throw new Error("PKCS7 填充非法");
  return buf.subarray(0, buf.length - n);
}

/* ---------------- 纯 JS DES（标准 FIPS 46-3 表） ---------------- */

const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
  23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9,
  8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];
const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];
const S = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7, 0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,
   4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0, 15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10, 3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,
   0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15, 13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8, 13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,
   13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7, 1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15, 13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,
   10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4, 3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9, 14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,
   4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14, 11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11, 10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,
   9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6, 4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1, 13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,
   1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2, 6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7, 1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,
   7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8, 2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];

const bytesToBits = (bytes) => {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
};
const bitsToBytes = (bits) => {
  const out = Buffer.alloc(bits.length >> 3);
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out[i >> 3] = b;
  }
  return out;
};
const permute = (bits, table) => table.map((i) => bits[i - 1]);
const xor = (a, b) => a.map((v, i) => v ^ b[i]);
const rotate = (bits, n) => bits.slice(n).concat(bits.slice(0, n));

function subkeys(keyBytes) {
  const k = permute(bytesToBits(keyBytes), PC1);
  let C = k.slice(0, 28), D = k.slice(28);
  const keys = [];
  for (let r = 0; r < 16; r++) {
    C = rotate(C, SHIFTS[r]);
    D = rotate(D, SHIFTS[r]);
    keys.push(permute(C.concat(D), PC2));
  }
  return keys;
}

function feistel(R, K) {
  const x = xor(permute(R, E), K);
  const sboxOut = [];
  for (let box = 0; box < 8; box++) {
    const b = x.slice(box * 6, box * 6 + 6);
    const row = (b[0] << 1) | b[5];
    const col = (b[1] << 3) | (b[2] << 2) | (b[3] << 1) | b[4];
    const v = S[box][row * 16 + col];
    for (let i = 3; i >= 0; i--) sboxOut.push((v >> i) & 1);
  }
  return permute(sboxOut, P);
}

function decryptBlock(block, decKeys) {
  const bits = permute(bytesToBits(block), IP);
  let L = bits.slice(0, 32), R = bits.slice(32);
  for (let r = 0; r < 16; r++) {
    const newR = xor(L, feistel(R, decKeys[r]));
    L = R;
    R = newR;
  }
  return bitsToBytes(permute(R.concat(L), FP));
}

// 供自测/调试
export const _internals = { subkeys, feistel, decryptBlock, permute, bytesToBits, bitsToBytes, IP };
