const HEX = '0123456789abcdef';

interface CryptoLike {
  getRandomValues?<T extends ArrayBufferView>(array: T): T;
}

export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  const cryptoObject = (globalThis as { crypto?: CryptoLike }).crypto;
  if (cryptoObject?.getRandomValues) {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  let result = '';
  for (const byte of bytes) {
    result += HEX.charAt(Math.floor(byte / 16)) + HEX.charAt(byte % 16);
  }
  return result;
}

export function createSessionId(): string {
  return randomHex(16);
}

export function createEventId(): string {
  return randomHex(12);
}
