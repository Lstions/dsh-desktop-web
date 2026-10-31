/**
 * A minimal QR encoder for TOTP enrolment.
 *
 * The bridge shows an `otpauth://` URI that an authenticator app must import.
 * Transcribing a 32-character base32 secret is the single most common cause of
 * "enrolment worked, sign-in fails", so the secret is offered as a scannable
 * code as well.
 *
 * This is a self-contained implementation of QR model 2, byte mode, error
 * correction level M, versions 1 through 10 — enough for a ~120 character
 * `otpauth://` URI and far smaller than pulling in a general-purpose QR
 * package. Fixed black-on-white: a themed code can render as invisible modules
 * against a dark panel.
 *
 * Format follows ISO/IEC 18004. The structure mirrors the classic reference
 * implementation by Project Nayuki (MIT), reduced to the single mode and level
 * this task needs.
 *
 * @module dsh-desktop-web/qr
 */

/** Error-correction level M: L/M/Q/H are indices 0..3 in the tables below. */
const ECC_LEVEL_M = 1;

/** Byte-mode indicator (0100), left-aligned into a 4-bit field. */
const MODE_BYTE = 0b0100;

/**
 * Per-version, per-level error-correction block structure.
 * Index 0 is unused so a version number can index directly.
 * Each entry: [eccCodewordsPerBlock, [ [blockCount, dataCodewordsPerBlock], ... ] ]
 */
const ECC_TABLE = [
  null,
  // version 1
  [, [[1, 16]]],
  [, [[1, 28]]],
  [, [[1, 44]]],
  [, [[2, 32]]],
  [, [[2, 43]]],
  [, [[4, 27]]],
  [, [[4, 31]]],
  [, [[2, 38], [2, 39]]],
  [, [[3, 36], [2, 37]]],
  [, [[4, 43], [1, 44]]],
];

/** ECC codewords per block, indexed [version][level]; level M only is filled. */
const ECC_CODEWORDS_PER_BLOCK = [null];
/** Number of ECC blocks, indexed [version]. */
const NUM_ECC_BLOCKS = [null];

// Build the two derived tables for level M from ECC_TABLE.
for (let version = 1; version <= 10; version += 1) {
  const groups = ECC_TABLE[version][ECC_LEVEL_M] ?? [];
  let blocks = 0;
  for (const [count] of groups) blocks += count;
  NUM_ECC_BLOCKS[version] = blocks;
  // Every block in a version shares the same ECC count for level M here.
  ECC_CODEWORDS_PER_BLOCK[version] = eccCodewordsFor(version, blocks);
}

/**
 * Derive the per-block ECC codeword count from the version's total capacity.
 * @param version - QR version 1..10.
 * @param blocks - number of error-correction blocks.
 * @returns ECC codewords per block.
 */
function eccCodewordsFor(version, blocks) {
  const total = rawDataModules(version) / 8 - totalDataCodewords(version);
  return Math.floor(total / blocks);
}

/** Modules available for data+ecc in one version, before function patterns. */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Total data codewords for one version at level M. */
function totalDataCodewords(version) {
  let sum = 0;
  for (const [count, codewords] of ECC_TABLE[version][ECC_LEVEL_M]) sum += count * codewords;
  return sum;
}

/** Alignment pattern centre coordinates for a version. */
function alignmentPositions(version) {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

/**
 * Append `bits` of `value` to a bit buffer.
 * @param buffer - growing array of 0/1 numbers.
 * @param value - value to append.
 * @param length - number of low bits to take.
 */
function appendBits(buffer, value, length) {
  for (let index = length - 1; index >= 0; index -= 1) buffer.push((value >>> index) & 1);
}

/**
 * Reed-Solomon divisor polynomial for `degree` error-correction codewords.
 * @param degree - ECC codeword count.
 * @returns coefficients, highest order first.
 */
function reedSolomonDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let term = 0; term < result.length; term += 1) {
      result[term] = multiply(result[term], root);
      if (term + 1 < result.length) result[term] ^= result[term + 1];
    }
    root = multiply(root, 0x02);
  }
  return result;
}

/** GF(256) multiply with the QR polynomial 0x11D. */
function multiply(left, right) {
  let product = 0;
  for (let index = 7; index >= 0; index -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((right >>> index) & 1) * left;
  }
  return product;
}

/**
 * Compute the Reed-Solomon remainder for one block.
 * @param data - block data codewords.
 * @param divisor - divisor from {@link reedSolomonDivisor}.
 * @returns the ECC codewords.
 */
function reedSolomonRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let index = 0; index < divisor.length; index += 1) {
      result[index] ^= multiply(divisor[index], factor);
    }
  }
  return result;
}

/**
 * Encode text into a QR module grid.
 * @param text - content to encode.
 * @returns a 2D array of booleans, `true` for dark modules.
 */
export function encodeQr(text) {
  const data = Buffer.from(text, 'utf8');

  // 1. Pick the smallest version whose data capacity fits the payload.
  let version = 1;
  let dataCapacityBits = 0;
  for (; version <= 10; version += 1) {
    const capacityBits = totalDataCodewords(version) * 8;
    // Header: 4-bit mode + character count (8 bits below version 10).
    const needed = 4 + clearBitsForVersion(version) + data.length * 8;
    if (needed <= capacityBits) {
      dataCapacityBits = capacityBits;
      break;
    }
  }
  if (version > 10) throw new Error('qr: payload too long for a version-10 code');

  // 2. Build the data bit stream: mode, length, payload, terminator, padding.
  const bits = [];
  appendBits(bits, MODE_BYTE, 4);
  appendBits(bits, data.length, clearBitsForVersion(version));
  for (const byte of data) appendBits(bits, byte, 8);
  appendBits(bits, 0, Math.min(4, dataCapacityBits - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < dataCapacityBits; pad ^= 0xec ^ 0x11) {
    appendBits(bits, pad, 8);
  }

  // 3. Split into blocks, add ECC, and interleave.
  const dataCodewords = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | bits[index + offset];
    dataCodewords.push(byte);
  }

  const blockGroups = ECC_TABLE[version][ECC_LEVEL_M];
  const eccLength = ECC_CODEWORDS_PER_BLOCK[version];
  const divisor = reedSolomonDivisor(eccLength);

  const dataBlocks = [];
  const eccBlocks = [];
  let offset = 0;
  for (const [count, blockLength] of blockGroups) {
    for (let block = 0; block < count; block += 1) {
      const chunk = dataCodewords.slice(offset, offset + blockLength);
      offset += blockLength;
      dataBlocks.push(chunk);
      eccBlocks.push(reedSolomonRemainder(chunk, divisor));
    }
  }

  const interleaved = [];
  const longestDataBlock = Math.max(...blockGroups.map(([, length]) => length));
  for (let index = 0; index < longestDataBlock; index += 1) {
    for (const block of dataBlocks) if (index < block.length) interleaved.push(block[index]);
  }
  for (let index = 0; index < eccLength; index += 1) {
    for (const block of eccBlocks) interleaved.push(block[index]);
  }

  // 4. Lay the codewords into the matrix with function patterns in place.
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  drawFunctionPatterns(modules, isFunction, size, version);
  drawCodewords(modules, isFunction, size, interleaved);
  // The mask must be chosen before it can be recorded, so drawFunctionPatterns
  // writes placeholder format bits and the real ones are written here, after
  // the data modules carry the chosen mask. A reader recovers the mask from
  // these bits, so they must describe the mask actually applied.
  const mask = chooseMask(modules, isFunction, size, version);
  applyMask(modules, isFunction, size, mask);
  drawFormatBits(modules, isFunction, size, mask);

  return modules;
}

/** Character-count field width for one version at this level. */
function clearBitsForVersion(version) {
  return version <= 9 ? 8 : 16;
}

/**
 * Draw every function pattern: finders, separators, timing, alignment, and the
 * reserved dark module.
 */
function drawFunctionPatterns(modules, isFunction, size, version) {
  const set = (row, column, dark) => {
    modules[row][column] = dark;
    isFunction[row][column] = true;
  };

  // Timing patterns.
  for (let index = 0; index < size; index += 1) {
    set(6, index, index % 2 === 0);
    set(index, 6, index % 2 === 0);
  }

  // Finder patterns with their separators. A finder is a 7x7 dark ring
  // enclosing a 3x3 dark core; `distance` is the Chebyshev distance from the
  // centre, so the ring is exactly the distance-3 shell and the core is
  // distance <= 1. The separator (distance 4) stays light.
  const finders = [[3, 3], [size - 4, 3], [3, size - 4]];
  for (const [centerRow, centerColumn] of finders) {
    for (let dr = -4; dr <= 4; dr += 1) {
      for (let dc = -4; dc <= 4; dc += 1) {
        const row = centerRow + dr;
        const column = centerColumn + dc;
        if (row < 0 || row >= size || column < 0 || column >= size) continue;
        const distance = Math.max(Math.abs(dr), Math.abs(dc));
        set(row, column, distance !== 2 && distance !== 4);
      }
    }
  }

  // Alignment patterns, except where they would overlap a finder.
  const positions = alignmentPositions(version);
  for (let index = 0; index < positions.length; index += 1) {
    for (let other = 0; other < positions.length; other += 1) {
      const corner = (index === 0 && other === 0)
        || (index === 0 && other === positions.length - 1)
        || (index === positions.length - 1 && other === 0);
      if (corner) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const distance = Math.max(Math.abs(dr), Math.abs(dc));
          set(
            positions[index] + dr,
            positions[other] + dc,
            distance !== 1,
          );
        }
      }
    }
  }

  // Reserve the format areas, then draw them with a placeholder mask.
  drawFormatBits(modules, isFunction, size, 0);
  drawVersionBits(modules, isFunction, size, version);
}

/** Draw the 15 format bits for one mask, in both copies. */
function drawFormatBits(modules, isFunction, size, mask) {
  const data = (ECC_LEVEL_M << 3) | mask;
  let remainder = data;
  for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;

  const set = (row, column, dark) => {
    modules[row][column] = dark;
    isFunction[row][column] = true;
  };

  for (let index = 0; index <= 5; index += 1) set(index, 8, ((bits >>> index) & 1) !== 0);
  set(7, 8, ((bits >>> 6) & 1) !== 0);
  set(8, 8, ((bits >>> 7) & 1) !== 0);
  set(8, 7, ((bits >>> 8) & 1) !== 0);
  for (let index = 9; index < 15; index += 1) set(8, 14 - index, ((bits >>> index) & 1) !== 0);

  for (let index = 0; index < 8; index += 1) set(8, size - 1 - index, ((bits >>> index) & 1) !== 0);
  for (let index = 8; index < 15; index += 1) set(size - 15 + index, 8, ((bits >>> index) & 1) !== 0);
  set(size - 8, 8, true);
}

/** Draw version information for versions 7 and up. */
function drawVersionBits(modules, isFunction, size, version) {
  if (version < 7) return;
  let remainder = version;
  for (let index = 0; index < 12; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  const bits = (version << 12) | remainder;
  for (let index = 0; index < 18; index += 1) {
    const dark = ((bits >>> index) & 1) !== 0;
    const row = size - 11 + (index % 3);
    const column = Math.floor(index / 3);
    modules[row][column] = dark;
    isFunction[row][column] = true;
    modules[column][row] = dark;
    isFunction[column][row] = true;
  }
}

/** Place the interleaved codewords in the zig-zag pattern. */
function drawCodewords(modules, isFunction, size, codewords) {
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const column = right - offset;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vertical : vertical;
        if (isFunction[row][column]) continue;
        if (index < codewords.length * 8) {
          modules[row][column] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) !== 0;
          index += 1;
        }
      }
    }
  }
}

/** Apply one mask to every data module. */
function applyMask(modules, isFunction, size, mask) {
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (isFunction[row][column]) continue;
      if (maskAt(mask, row, column)) modules[row][column] = !modules[row][column];
    }
  }
}

/** The eight mask predicates from the standard. */
function maskAt(mask, row, column) {
  switch (mask) {
    case 0: return (row + column) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return column % 3 === 0;
    case 3: return (row + column) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5: return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6: return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    case 7: return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
    default: return false;
  }
}

/** Score one mask by the standard's four penalty rules, lowest wins. */
function chooseMask(modules, isFunction, size, version) {
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((row) => row.slice());
    const functionCopy = isFunction.map((row) => row.slice());
    applyMask(candidate, functionCopy, size, mask);
    // Redraw format bits for this mask so the score sees the real modules.
    drawFormatBits(candidate, functionCopy, size, mask);
    const score = penalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
  }
  return best;
}

/** The four penalty rules, summed. */
function penalty(modules, size) {
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules in a line.
  for (let row = 0; row < size; row += 1) {
    let run = 1;
    for (let column = 1; column < size; column += 1) {
      if (modules[row][column] === modules[row][column - 1]) {
        run += 1;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  for (let column = 0; column < size; column += 1) {
    let run = 1;
    for (let row = 1; row < size; row += 1) {
      if (modules[row][column] === modules[row - 1][column]) {
        run += 1;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const value = modules[row][column];
      if (value === modules[row][column + 1]
        && value === modules[row + 1][column]
        && value === modules[row + 1][column + 1]) score += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns.
  const pattern = [true, false, true, true, true, false, true];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= size - 7; column += 1) {
      let matches = true;
      for (let offset = 0; offset < 7; offset += 1) {
        if (modules[row][column + offset] !== pattern[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) score += 40;
    }
  }
  for (let column = 0; column < size; column += 1) {
    for (let row = 0; row <= size - 7; row += 1) {
      let matches = true;
      for (let offset = 0; offset < 7; offset += 1) {
        if (modules[row + offset][column] !== pattern[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) score += 40;
    }
  }

  // Rule 4: deviation from a 50% dark ratio.
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * Render text as a standalone SVG string.
 * @param text - content to encode.
 * @param options - `size` in pixels and `margin` in modules.
 * @returns the SVG document.
 */
export function qrSvg(text, { size = 220, margin = 1 } = {}) {
  const modules = encodeQr(text);
  const count = modules.length;
  const total = count + margin * 2;
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (!modules[row][column]) continue;
      path += `M${column + margin},${row + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `
    + `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img">`
    + `<rect width="${total}" height="${total}" fill="#ffffff"/>`
    + `<path d="${path}" fill="#000000"/>`
    + '</svg>';
}

/**
 * Render text as an `<img src>` data URI.
 * @param text - content to encode.
 * @returns a `data:image/svg+xml;base64,...` URI.
 */
export function qrDataUri(text) {
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg(text), 'utf8').toString('base64')}`;
}
