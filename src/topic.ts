import { randomBytes } from "node:crypto";
import { TOPIC_CODE_LENGTH } from "./types.js";

const TOPIC_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Cryptographically random alphanumeric pairing code. */
export function generateTopicCode(length = TOPIC_CODE_LENGTH): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += TOPIC_ALPHABET[bytes[i]! % TOPIC_ALPHABET.length];
  }
  return out;
}
