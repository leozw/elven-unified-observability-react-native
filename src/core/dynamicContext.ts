import {
  ROOT_CONTEXT,
  defaultTextMapGetter,
  defaultTextMapSetter,
  type Attributes,
  type Context,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { StackContextManager } from '@opentelemetry/sdk-trace-web';
import { sha256Hex } from './hash';
import { toOtelContext, toTraceContext } from './context';
import type { Sanitizer } from './sanitizer';
import type {
  AttributeInputs,
  ResolvedConfig,
  TenantContextInput,
  TraceContext,
  TraceCarrier,
  UserContextInput,
} from '../types';

export class DynamicTelemetryContext {
  private readonly contextManager = new StackContextManager().enable();
  private readonly propagator = new W3CTraceContextPropagator();
  private userAttributes: Attributes = {};
  private tenantAttributes: Attributes = {};
  private sessionAttributes: Attributes;
  private businessAttributes: Attributes = {};
  private navigationAttributes: Attributes = {};

  constructor(
    private readonly config: ResolvedConfig,
    private readonly sanitizer: Sanitizer
  ) {
    this.sessionAttributes = { 'session.id': config.sessionId };
  }

  active(): Context {
    return this.contextManager.active();
  }

  run<T>(target: Context | TraceContext | undefined, operation: () => T): T {
    return this.contextManager.with(
      toOtelContext(target, this.active()),
      operation
    );
  }

  bind<T>(target: Context | TraceContext | undefined, value: T): T {
    return this.contextManager.bind(
      toOtelContext(target, this.active()),
      value
    );
  }

  capture(): TraceContext | undefined {
    return toTraceContext(this.active());
  }

  inject(
    carrier: TraceCarrier = {},
    source?: Context | TraceContext
  ): TraceCarrier {
    const output = { ...carrier };
    this.propagator.inject(
      toOtelContext(source, this.active()),
      output,
      defaultTextMapSetter
    );
    return output;
  }

  extract(
    carrier: Readonly<Record<string, string | ReadonlyArray<string>>>
  ): Context {
    return this.propagator.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);
  }

  setUser(value: UserContextInput | null): void {
    if (!value) {
      this.userAttributes = {};
      return;
    }
    const id = this.config.privacy.hashUserId
      ? pseudonymize(this.identityNamespace('user'), value.id)
      : this.sanitizer.message(value.id);
    this.userAttributes = {
      'enduser.pseudo.id': id,
      ...prefixAttributes('user', this.sanitizer.attributes(value.attributes)),
    };
  }

  setTenant(value: TenantContextInput | null): void {
    if (!value) {
      this.tenantAttributes = {};
      return;
    }
    const id = this.config.privacy.hashTenantId
      ? pseudonymize(this.identityNamespace('tenant'), value.id)
      : this.sanitizer.message(value.id);
    this.tenantAttributes = {
      'tenant.id': id,
      ...prefixAttributes(
        'tenant',
        this.sanitizer.attributes(value.attributes)
      ),
    };
  }

  setSession(id: string | null, attributes?: AttributeInputs): void {
    this.sessionAttributes = id
      ? {
          'session.id': this.sanitizer.message(id),
          ...prefixAttributes('session', this.sanitizer.attributes(attributes)),
        }
      : {};
  }

  setBusinessContext(attributes: AttributeInputs | null): void {
    this.businessAttributes = attributes
      ? prefixAttributes('business', this.sanitizer.attributes(attributes))
      : {};
  }

  telemetryAttributes(): Attributes {
    return {
      ...this.sessionAttributes,
      ...this.userAttributes,
      ...this.tenantAttributes,
      ...this.businessAttributes,
      ...this.navigationAttributes,
    };
  }

  metricAttributes(): Attributes {
    const screenName = this.navigationAttributes['app.screen.name'];
    return screenName === undefined ? {} : { 'app.screen.name': screenName };
  }

  setNavigationContext(attributes: AttributeInputs | null): void {
    this.navigationAttributes = attributes
      ? this.sanitizer.attributes(attributes)
      : {};
  }

  clear(): void {
    this.userAttributes = {};
    this.tenantAttributes = {};
    this.businessAttributes = {};
    this.navigationAttributes = {};
    this.sessionAttributes = {};
  }

  shutdown(): void {
    this.contextManager.disable();
  }

  private identityNamespace(kind: 'tenant' | 'user'): string {
    return [
      this.config.serviceNamespace,
      this.config.serviceName,
      this.config.environment,
      kind,
    ]
      .filter(Boolean)
      .join(':');
  }
}

function pseudonymize(namespace: string, value: string): string {
  return `sha256:${sha256Hex(`${namespace}:${value}`)}`;
}

function prefixAttributes(prefix: string, attributes: Attributes): Attributes {
  const output: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) output[`${prefix}.${key}`] = value;
  }
  return output;
}
