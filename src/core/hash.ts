import { sha256 } from '@noble/hashes/sha2.js';
import { utf8StringToBytes } from './encoding';

export function sha256Hex(value: string): string {
  let output = '';
  for (const byte of sha256(utf8StringToBytes(value))) {
    output += byte.toString(16).padStart(2, '0');
  }
  return output;
}
