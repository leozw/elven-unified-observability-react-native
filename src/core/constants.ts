import type { LogLevel } from '../types';

export const SDK_NAME = 'elven-unified-observability-react-native';
export const SDK_VERSION = '0.3.0';
export const ATTR_SERVICE_NAME = 'service.name';
export const ATTR_SERVICE_VERSION = 'service.version';
export const ATTR_SERVICE_NAMESPACE = 'service.namespace';
export const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';

export const LOG_LEVELS: ReadonlyArray<LogLevel> = [
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
];

export const DEFAULT_REDACT_KEYS: ReadonlyArray<string | RegExp> = [
  /authorization/i,
  /cookie/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /api[-_.]?key/i,
  /client[-_.]?secret/i,
  /session[-_.]?token/i,
  /credit[-_.]?card/i,
  /card[-_.]?(number|cvv|cvc)/i,
  /request[-_.]?body/i,
  /response[-_.]?body/i,
  /db\.statement/i,
  /email/i,
  /phone/i,
  /cpf/i,
  /cnpj/i,
];

export const REDACTED_VALUE = '[REDACTED]';
