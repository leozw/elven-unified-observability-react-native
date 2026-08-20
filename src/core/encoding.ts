/* eslint-disable no-bitwise -- UTF-8 encoding and decoding operates on bit fields. */

interface TextEncoderLike {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
  encodeInto(
    source: string,
    destination: Uint8Array
  ): { read: number; written: number };
}

class Utf8TextEncoder implements TextEncoderLike {
  readonly encoding = 'utf-8';

  encode(input = ''): Uint8Array {
    return encodeUtf8(input);
  }

  encodeInto(
    source: string,
    destination: Uint8Array
  ): { read: number; written: number } {
    let read = 0;
    let written = 0;
    while (read < source.length) {
      const next = readCodePoint(source, read);
      const bytes = codePointBytes(next.codePoint);
      if (written + bytes.length > destination.length) break;
      destination.set(bytes, written);
      written += bytes.length;
      read += next.width;
    }
    return { read, written };
  }
}

export function ensureTextEncoder(): void {
  const target = globalThis as unknown as {
    TextEncoder?: new () => TextEncoderLike;
  };
  if (typeof target.TextEncoder === 'undefined') {
    Object.defineProperty(target, 'TextEncoder', {
      configurable: true,
      enumerable: false,
      value: Utf8TextEncoder,
      writable: true,
    });
  }
}

export function utf8ByteLength(value: string): number {
  return encodeUtf8(value).length;
}

export function utf8StringToBytes(value: string): Uint8Array {
  return encodeUtf8(value);
}

export function utf8BytesToString(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index] ?? 0;
    if (first < 0x80) {
      output += String.fromCharCode(first);
      index += 1;
      continue;
    }
    const sequence = decodeSequence(bytes, index);
    output += String.fromCodePoint(sequence.codePoint);
    index += sequence.width;
  }
  return output;
}

function encodeUtf8(value: string): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < value.length;) {
    const next = readCodePoint(value, index);
    output.push(...codePointBytes(next.codePoint));
    index += next.width;
  }
  return Uint8Array.from(output);
}

function readCodePoint(
  value: string,
  index: number
): { codePoint: number; width: number } {
  const first = value.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff) {
    const second = value.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return {
        codePoint: 0x10000 + (first - 0xd800) * 0x400 + (second - 0xdc00),
        width: 2,
      };
    }
    return { codePoint: 0xfffd, width: 1 };
  }
  if (first >= 0xdc00 && first <= 0xdfff) {
    return { codePoint: 0xfffd, width: 1 };
  }
  return { codePoint: first, width: 1 };
}

function codePointBytes(codePoint: number): Uint8Array {
  if (codePoint <= 0x7f) return Uint8Array.of(codePoint);
  if (codePoint <= 0x7ff) {
    return Uint8Array.of(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
  }
  if (codePoint <= 0xffff) {
    return Uint8Array.of(
      0xe0 | (codePoint >> 12),
      0x80 | ((codePoint >> 6) & 0x3f),
      0x80 | (codePoint & 0x3f)
    );
  }
  return Uint8Array.of(
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f)
  );
}

function decodeSequence(
  bytes: Uint8Array,
  index: number
): { codePoint: number; width: number } {
  const first = bytes[index] ?? 0;
  const expectedWidth =
    first >= 0xc2 && first <= 0xdf
      ? 2
      : first >= 0xe0 && first <= 0xef
        ? 3
        : first >= 0xf0 && first <= 0xf4
          ? 4
          : 0;
  if (expectedWidth === 0 || index + expectedWidth > bytes.length) {
    return { codePoint: 0xfffd, width: 1 };
  }
  const continuation = Array.from(
    bytes.subarray(index + 1, index + expectedWidth)
  );
  if (continuation.some((byte) => (byte & 0xc0) !== 0x80)) {
    return { codePoint: 0xfffd, width: 1 };
  }
  let codePoint = first & (0x7f >> expectedWidth);
  for (const byte of continuation) {
    codePoint = (codePoint << 6) | (byte & 0x3f);
  }
  const minimum =
    expectedWidth === 2 ? 0x80 : expectedWidth === 3 ? 0x800 : 0x10000;
  if (
    codePoint < minimum ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return { codePoint: 0xfffd, width: expectedWidth };
  }
  return { codePoint, width: expectedWidth };
}
