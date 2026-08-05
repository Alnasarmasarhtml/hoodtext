/**
 * Keccak-256 (original padding, NOT SHA3-256) and EIP-55 address checksumming.
 *
 * Implemented here with zero dependencies on purpose: `infra/` has no node_modules of
 * its own, and reaching into another workspace's dependency tree to borrow `viem`
 * would make the deploy script break whenever that package's deps are reshuffled.
 *
 * Verified against the standard vectors in `selfTest()` below.
 */

const MASK64 = (1n << 64n) - 1n;
const RATE_BYTES = 136; // 1600 - 2*256 bits

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** rho offsets, indexed [x][y] */
const RHO = [
  [0n, 36n, 3n, 41n, 18n],
  [1n, 44n, 10n, 45n, 2n],
  [62n, 6n, 43n, 15n, 61n],
  [28n, 55n, 25n, 21n, 56n],
  [27n, 20n, 39n, 8n, 14n],
];

/**
 * @param {bigint} value
 * @param {bigint} bits
 * @returns {bigint}
 */
function rotl64(value, bits) {
  if (bits === 0n) return value & MASK64;
  return ((value << bits) | (value >> (64n - bits))) & MASK64;
}

/**
 * The Keccak-f[1600] permutation, in place.
 * @param {bigint[]} a 25 lanes, indexed x + 5*y
 */
function keccakF1600(a) {
  const c = new Array(5).fill(0n);
  const d = new Array(5).fill(0n);
  const b = new Array(25).fill(0n);

  for (let round = 0; round < 24; round += 1) {
    // theta
    for (let x = 0; x < 5; x += 1) {
      c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    }
    for (let x = 0; x < 5; x += 1) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1n);
    }
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        a[x + 5 * y] ^= d[x];
      }
    }

    // rho + pi
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(a[x + 5 * y], RHO[x][y]);
      }
    }

    // chi
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        a[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & b[((x + 2) % 5) + 5 * y] & MASK64);
      }
    }

    // iota
    a[0] ^= ROUND_CONSTANTS[round];
  }
}

/**
 * @param {Uint8Array} input
 * @returns {Uint8Array} 32-byte digest
 */
export function keccak256(input) {
  const state = new Array(25).fill(0n);

  // Pad: 0x01 ... 0x80 over the rate.
  const padLen = RATE_BYTES - (input.length % RATE_BYTES);
  const padded = new Uint8Array(input.length + padLen);
  padded.set(input, 0);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  // Absorb.
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane += 1) {
      let word = 0n;
      for (let byte = 7; byte >= 0; byte -= 1) {
        word = (word << 8n) | BigInt(padded[offset + lane * 8 + byte]);
      }
      state[lane] ^= word;
    }
    keccakF1600(state);
  }

  // Squeeze 32 bytes (rate is larger, so one pass suffices).
  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane += 1) {
    let word = state[lane];
    for (let byte = 0; byte < 8; byte += 1) {
      out[lane * 8 + byte] = Number(word & 0xffn);
      word >>= 8n;
    }
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string} lowercase hex, no 0x prefix
 */
export function toHex(bytes) {
  let s = '';
  for (const byte of bytes) s += byte.toString(16).padStart(2, '0');
  return s;
}

/**
 * @param {string} value
 * @returns {boolean} true when `value` is a syntactically valid 20-byte hex address
 */
export function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

export { ZERO_ADDRESS };

/**
 * @param {string} value
 * @returns {boolean} true when `value` is the zero address
 */
export function isZeroAddress(value) {
  return isAddress(value) && value.toLowerCase() === ZERO_ADDRESS;
}

/**
 * EIP-55 mixed-case checksum encoding.
 * @param {string} address a 0x-prefixed 20-byte hex address, any casing
 * @returns {`0x${string}`}
 */
export function toChecksumAddress(address) {
  if (!isAddress(address)) {
    throw new Error(`not a 20-byte hex address: ${String(address)}`);
  }
  const lower = address.slice(2).toLowerCase();
  const hash = toHex(keccak256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < lower.length; i += 1) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return /** @type {`0x${string}`} */ (out);
}

/**
 * Self-check against the published Keccak-256 and EIP-55 vectors. Called by the
 * scripts before they emit any address, so a broken build can never silently write
 * a wrongly-checksummed address into generated source.
 * @returns {void}
 * @throws {Error} when a vector fails
 */
export function selfTest() {
  const enc = new TextEncoder();
  /** @type {[string, string][]} */
  const digestVectors = [
    ['', 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
    ['abc', '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
    [
      'The quick brown fox jumps over the lazy dog',
      '4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15',
    ],
  ];
  for (const [input, expected] of digestVectors) {
    const actual = toHex(keccak256(enc.encode(input)));
    if (actual !== expected) {
      throw new Error(`keccak256 self-test failed for ${JSON.stringify(input)}: ${actual} != ${expected}`);
    }
  }

  // A 200-byte input exercises multi-block absorption.
  const long = enc.encode('a'.repeat(200));
  if (toHex(keccak256(long)).length !== 64) {
    throw new Error('keccak256 self-test failed: bad digest length for multi-block input');
  }

  const checksumVectors = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  ];
  for (const expected of checksumVectors) {
    const actual = toChecksumAddress(expected.toLowerCase());
    if (actual !== expected) {
      throw new Error(`EIP-55 self-test failed: ${actual} != ${expected}`);
    }
  }
}
