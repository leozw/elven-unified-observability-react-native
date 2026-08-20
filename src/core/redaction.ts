const CREDENTIAL_ASSIGNMENT =
  /\b(password|passwd|pwd|secret|token|api[-_]?key|authorization|cookie|set-cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const AUTHORIZATION_VALUE = /\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi;
const JWT_VALUE = /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi;
const URL_USER_INFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^@\s/:]+:[^@\s]+@/gi;
const EMAIL_ADDRESS =
  /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/gi;

export function redactTextContent(value: string): string {
  return value
    .replace(URL_USER_INFO, '$1[REDACTED]@')
    .replace(AUTHORIZATION_VALUE, '$1 [REDACTED]')
    .replace(JWT_VALUE, '[REDACTED]')
    .replace(CREDENTIAL_ASSIGNMENT, '$1=[REDACTED]')
    .replace(EMAIL_ADDRESS, '[REDACTED]');
}
