const CREDENTIAL_ASSIGNMENT =
  /\b(password|passwd|pwd|secret|token|api[-_]?key|authorization|cookie|set-cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const AUTHORIZATION_VALUE = /\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi;
const JWT_VALUE = /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi;
const URL_USER_INFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^@\s/:]+:[^@\s]+@/gi;
const EMAIL_ADDRESS =
  /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/gi;
const MAX_INPUT_CHARS = 65_536;
const MAX_TOKEN_CHARS = 1_024;
const WHITESPACE = /\s/;

export function isRedactionInputBounded(value: string): boolean {
  if (value.length > MAX_INPUT_CHARS) return false;
  let tokenLength = 0;
  // Bound ambiguous URL/email searches before regex work. Drop the whole field,
  // not a token fragment that could expose part of a quoted credential.
  for (let index = 0; index < value.length; index += 1) {
    tokenLength = WHITESPACE.test(value.charAt(index)) ? 0 : tokenLength + 1;
    if (tokenLength > MAX_TOKEN_CHARS) return false;
  }
  return true;
}

export function redactTextContent(value: string): string {
  if (!isRedactionInputBounded(value)) return '[OVERSIZE]';
  return value
    .replace(URL_USER_INFO, '$1[REDACTED]@')
    .replace(AUTHORIZATION_VALUE, '$1 [REDACTED]')
    .replace(JWT_VALUE, '[REDACTED]')
    .replace(CREDENTIAL_ASSIGNMENT, '$1=[REDACTED]')
    .replace(EMAIL_ADDRESS, '[REDACTED]');
}
