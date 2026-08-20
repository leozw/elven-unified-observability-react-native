# Instrumentação React Native com Elven Observability

O SDK **Elven Unified Observability for React Native** coleta logs, métricas, traces, erros e sinais de performance de aplicações Android e iOS em um único pipeline correlacionado.

Após uma inicialização curta, a maior parte da instrumentação funciona automaticamente. Os pontos que dependem do contexto de negócio, como usuário, sessão, navegação e operações críticas, possuem APIs manuais pequenas e tipadas.

> Use este SDK em aplicativos React Native. Para aplicações web no navegador, use o Grafana Faro Web SDK. Para backends Node.js, use o pacote unificado de Node.js da Elven.

---

### Visão geral

A Elven Observability centraliza os sinais técnicos do aplicativo e dos serviços de backend. Isso permite partir de um erro visto no celular, localizar os logs relacionados, acompanhar o trace distribuído até a API e analisar as métricas do mesmo período.

O aplicativo envia os três sinais pelo padrão OpenTelemetry OTLP para um Collector ou gateway homologado pela Elven:

```text
Aplicativo React Native
        │
        │  logs, métricas e traces correlacionados
        │  OTLP/HTTP JSON sobre TLS
        ▼
Elven Collector / Telemetry Gateway
        │
        ├── logs     → Loki
        ├── métricas → Mimir
        └── traces   → Tempo
```

O Collector é a fronteira de ingestão. Ele aplica autenticação, tenancy, limites, redaction adicional e encaminhamento para os backends. O aplicativo **não deve** receber credenciais do Loki, Mimir ou Tempo.

Logs e spans compartilham `trace_id` e `span_id`. Métricas usam exemplars OTLP para manter correlação com traces sem transformar IDs em labels de alta cardinalidade.

---

### O que é coletado

| Sinal           | Automático                                                                    | API manual                                                   |
| --------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Logs**        | Níveis selecionados de `console`, erros e eventos de lifecycle                | Logs estruturados `debug`, `info`, `warn`, `error` e `fatal` |
| **Traces**      | `fetch`, XHR, telas, lifecycle, erros e performance nativa                    | Spans, eventos de span e propagação de contexto              |
| **Métricas**    | Requisições HTTP, telas, exceções, inicialização e eventos nativos            | Counter, up/down counter, gauge e histogram                  |
| **Erros**       | Erros JavaScript, unhandled rejections e diagnósticos nativos suportados      | `captureException()` para erros tratados                     |
| **Performance** | App start, primeira frame, frames lentas/congeladas, rede, ANR/hang e memória | Spans e histogramas de operações importantes                 |
| **Contexto**    | Aplicação, versão, build, ambiente, plataforma, dispositivo e tela            | Usuário pseudonimizado, tenant, sessão e contexto de negócio |

Por padrão, o SDK não captura corpos HTTP, parâmetros de rota, query strings ou headers sensíveis.

---

### Compatibilidade

Matriz validada para a versão `0.2.0`, em agosto de 2026:

| Ambiente              | Suporte                                           |
| --------------------- | ------------------------------------------------- |
| React Native          | `0.79.7`, `0.86.x` e `0.87.x`                     |
| React                 | `19.x`                                            |
| Runtime               | Hermes e New Architecture                         |
| Android               | API 24 ou superior, Java 17                       |
| iOS bare React Native | iOS 15.1 ou superior                              |
| Expo SDK 57           | Development Build, EAS Build e prebuild/CNG       |
| Expo Go               | Fallback somente JavaScript, sem recursos nativos |
| React Native Web      | Best effort; fora do contrato Android/iOS         |

O React Native `0.79.7` é uma faixa isolada de compatibilidade estendida para aplicações existentes. As versões `0.79.0` a `0.79.6` e `0.80` a `0.85` não estão incluídas. Como a linha 0.79 não recebe mais manutenção oficial, o cliente deve manter um plano de atualização para uma versão suportada do React Native.

O pacote não declara suporte à Legacy Architecture, JavaScriptCore, Windows, macOS, visionOS ou tvOS.

> Suporte significa que instalação, TypeScript, Codegen, autolinking e builds Android/iOS Release passaram na matriz declarada. Entrega de MetricKit e crashes nativos deve ser validada em dispositivos reais antes de um rollout amplo.

---

### Pré-requisitos

Antes da integração, obtenha com a equipe Elven:

- URL HTTPS do Collector ou gateway OTLP;
- nome padronizado do serviço;
- ambiente, como `production`, `staging` ou `development`;
- origens das APIs próprias que poderão receber o header W3C `traceparent`;
- política de tenancy, retenção, consentimento e tratamento de dados aplicável ao aplicativo.

O projeto também deve usar uma versão de Node.js compatível com seu React Native ou Expo. A matriz do SDK é validada com Node.js `^22.13.0` ou `>=24.3.0`.

---

### Instalação

Com npm:

```bash
npm install elven-unified-observability-react-native
```

Com Yarn:

```bash
yarn add elven-unified-observability-react-native
```

O pacote já contém o pipeline unificado. Não instale um pacote separado para logs e não configure exportação direta para Loki, Mimir ou Tempo.

Como o SDK contém código nativo, gere um novo binário após a instalação ou atualização.

Para iOS bare React Native, atualize os pods:

```bash
npx pod-install
```

Android e iOS usam autolinking e React Native Codegen. Não é necessário registrar o módulo manualmente.

---

### Quickstart

Crie um arquivo dedicado e inicialize o SDK o mais cedo possível, sem bloquear a primeira renderização.

#### `src/observability.ts`

```typescript
import { ElvenObservability } from 'elven-unified-observability-react-native';

void ElvenObservability.initialize({
  serviceName: 'customer-mobile-app',
  version: '2.4.0',
  environment: 'production',
  collector: {
    endpoint: 'https://otel.example.com',
  },
  instrumentations: {
    network: {
      enabled: true,
      propagateTraceHeadersTo: ['https://api.example.com'],
    },
  },
}).catch(() => undefined);
```

O endpoint é a URL base. O SDK acrescenta automaticamente:

```text
/v1/logs
/v1/metrics
/v1/traces
```

Em produção, o endpoint deve usar HTTPS. Não coloque token reutilizável no bundle, no `app.json`, em recursos Android/iOS ou em variáveis `EXPO_PUBLIC_*`.

#### Bare React Native

Importe a configuração antes de registrar o aplicativo:

```javascript
import './src/observability';

import { AppRegistry } from 'react-native';
import App from './src/App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
```

#### Expo

Importe a configuração antes de `registerRootComponent`:

```javascript
import './src/observability';

import { registerRootComponent } from 'expo';
import App from './src/App';

registerRootComponent(App);
```

Para Expo Router, use um entry point próprio:

```javascript
import './src/observability';
import 'expo-router/entry';
```

Depois dessa inicialização, logs selecionados, HTTP, erros JavaScript, lifecycle e telemetria nativa disponível começam a ser coletados.

---

### Expo: Development Build e Expo Go

Para obter todos os sinais nativos no Expo, use Development Build, EAS Build ou prebuild:

```bash
npx expo install expo-dev-client
npx expo prebuild
npx expo run:android
# ou
npx expo run:ios
```

Recompile o aplicativo sempre que instalar ou atualizar o SDK, pois uma atualização OTA não consegue adicionar ou substituir código nativo. Configure `runtimeVersion` para impedir que um bundle incompatível seja entregue a um binário antigo.

No Expo Go, a inicialização continua segura, mas funciona somente a camada JavaScript:

- logs, métricas, traces, `fetch`, XHR e erros JavaScript continuam disponíveis;
- crashes nativos, ANR/hang, frames, metadados nativos e fila persistente nativa ficam indisponíveis;
- `ElvenObservability.health().nativeBridgeAvailable` retorna `false`.

Expo Go é útil para desenvolvimento rápido, mas não comprova a integração nativa.

---

### Instrumentação automática

Cada integração pode ser controlada separadamente:

```typescript
instrumentations: {
  console: {
    enabled: true,
    levels: ['warn', 'error'],
    preserveOriginal: true,
  },
  network: {
    enabled: true,
    fetch: true,
    xhr: true,
    ignoreUrls: [/\/health$/],
    propagateTraceHeadersTo: ['https://api.example.com'],
    captureRequestHeaders: ['content-type'],
    captureResponseHeaders: ['content-type', 'retry-after'],
  },
  errors: {
    enabled: true,
    javascriptErrors: true,
    unhandledRejections: true,
    nativeCrashes: true,
  },
  lifecycle: {
    enabled: true,
    flushOnBackground: true,
    nativeEvents: true,
    anr: true,
    frozenFrames: true,
  },
}
```

`lifecycle.nativeEvents` controla lifecycle nativo, app start, frames, ANR/hang e memória. Crashes nativos continuam sob `errors.nativeCrashes`.

Chamadas do próprio SDK ao Collector são ignoradas para evitar spans recursivos. A inicialização é idempotente e as funções globais instrumentadas são restauradas no `shutdown()`.

Para desativar um pipeline inteiro, use `signals`, por exemplo: `signals: { logs: true, metrics: true, traces: false }`.

---

### Rede e propagação de traces

O SDK cria spans para `fetch` e XHR. A propagação W3C é mais restrita: `traceparent` e `tracestate` só são enviados para destinos explicitamente permitidos.

```typescript
network: {
  enabled: true,
  fetch: true,
  xhr: true,
  propagateTraceHeadersTo: [
    'https://api.example.com',
    'https://uploads.example.com/v2/',
  ],
}
```

Boas práticas:

- inclua apenas APIs controladas pela organização;
- não permita domínios de terceiros, analytics ou pagamentos externos;
- prefira origens e caminhos exatos a expressões regulares amplas;
- confirme que o backend aceita e continua o contexto W3C;
- mantenha corpos HTTP desabilitados;
- capture somente headers técnicos de baixa sensibilidade, quando necessários.

A lista de propagação é vazia por padrão. Portanto, os spans HTTP continuam sendo criados mesmo quando nenhum header é enviado ao destino.

---

### Navegação e telas

Para qualquer roteador, registre um nome estável de tela:

```typescript
ElvenObservability.recordScreen('Checkout');
```

Com React Navigation, use o adaptador sem instalar uma dependência adicional no SDK:

```tsx
const navigation =
  ElvenObservability.createNavigationInstrumentation(navigationRef);

<NavigationContainer
  ref={navigationRef}
  onReady={navigation.onReady}
  onStateChange={navigation.onStateChange}
>
  {children}
</NavigationContainer>;
```

O SDK registra o nome da rota, mas não captura parâmetros. Use nomes como `ProductDetails` em vez de caminhos com IDs, e nunca coloque CPF, e-mail, pedido ou outro identificador no nome da tela.

---

### Logs estruturados

```typescript
ElvenObservability.logs.info('Order submitted', {
  'order.item_count': 3,
  'payment.method': 'pix',
});

ElvenObservability.logs.error(
  'Payment rejected',
  { 'payment.provider': 'provider-name' },
  { error }
);
```

Use mensagens estáveis e atributos estruturados. Não monte mensagens com tokens, documentos, e-mails, payloads ou identificadores pessoais.

Em produção, os defaults preservam 100% de `warn`, `error` e `fatal`, enquanto `debug` e `info` usam sampling para controlar volume.

---

### Métricas customizadas

```typescript
ElvenObservability.metrics.counter('cart.item.added', 1, {
  'item.category': 'book',
});

ElvenObservability.metrics.gauge('cart.item.count', 3, undefined, {
  unit: '{item}',
});

ElvenObservability.metrics.histogram(
  'checkout.duration',
  820,
  { 'checkout.result': 'success' },
  { unit: 'ms' }
);
```

Atributos de métricas devem ter baixa cardinalidade. Não use ID de usuário, tenant, pedido, URL completa, mensagem de exceção ou chave de instância como label.

---

### Eventos de negócio e exceções

```typescript
ElvenObservability.event('checkout.coupon.applied', {
  'coupon.type': 'percentage',
  'coupon.value': 10,
});

ElvenObservability.captureException(
  error,
  { 'payment.provider': 'provider-name' },
  { handled: true, mechanism: 'validation' }
);
```

Um evento de negócio produz um span, um log e uma métrica correlacionados. Use essa API para acontecimentos operacionais relevantes, não como substituto de uma plataforma de product analytics ou de consentimento.

Use `captureException()` para erros tratados pela aplicação. Erros não tratados já são capturados pela instrumentação automática quando habilitada.

#### Source maps e symbolication

O SDK captura stacks limitadas, mas não publica artefatos de symbolication. Preserve, por versão e build, os source maps do bundle JavaScript, o `mapping.txt` do Android/R8 e os dSYMs do iOS. Configure o processo seguro de symbolication usado pela sua organização; sem esses artefatos, stacks de builds minificados podem ser pouco legíveis.

---

### Spans e contexto assíncrono

```typescript
import {
  ElvenObservability,
  SpanStatusCode,
} from 'elven-unified-observability-react-native';

const span = ElvenObservability.traces.startSpan('checkout.confirm', {
  attributes: { 'checkout.currency': 'BRL' },
});

try {
  const response = await span.run(() => fetch(checkoutUrl));

  ElvenObservability.logs.info(
    'Checkout completed',
    { 'http.response.status_code': response.status },
    { context: span.context }
  );

  ElvenObservability.metrics.histogram(
    'checkout.order.value',
    149.9,
    { 'checkout.currency': 'BRL' },
    { context: span.context, unit: 'BRL' }
  );

  span.setStatus({ code: SpanStatusCode.OK });
} catch (error) {
  span.recordException(error).setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
  throw error;
} finally {
  span.end();
}
```

Hermes não fornece o `AsyncLocalStorage` do Node.js. O SDK preserva contexto nas fronteiras que controla, mas não promete contexto implícito depois de todo `await`.

Use `span.run()` ao iniciar trabalho filho. Depois de um `await`, passe `{ context: span.context }` explicitamente para logs e métricas que precisam permanecer correlacionados.

---

### Usuário, tenant, sessão e contexto de negócio

Defina contexto somente após obter valores válidos da aplicação:

```typescript
ElvenObservability.context.setUser({ id: opaqueUserId });
ElvenObservability.context.setTenant({ id: opaqueTenantId });
ElvenObservability.context.setSession(randomSessionId);
ElvenObservability.context.setBusinessContext({ region: 'south' });
```

No logout:

```typescript
ElvenObservability.context.setUser(null);
ElvenObservability.context.setTenant(null);
ElvenObservability.context.setSession(null);
ElvenObservability.context.setBusinessContext(null);
```

IDs de usuário e tenant são pseudonimizados por padrão. Hash não é anonimização: prefira IDs opacos e aleatórios, aplique consentimento quando necessário e nunca envie nome, e-mail, CPF, telefone ou credenciais.

O tenant enviado pelo aplicativo serve para correlação. Ele não deve ser usado pelo gateway como única prova de autorização ou isolamento.

---

### Sampling e controle de volume

Defaults de produção:

| Controle                       |                Default |
| ------------------------------ | ---------------------: |
| Root traces                    |                    10% |
| Logs `debug`                   |                     5% |
| Logs `info`                    |                    25% |
| Logs `warn`, `error` e `fatal` |                   100% |
| Intervalo de métricas          |            60 segundos |
| Fila durável JS                |                512 KiB |
| Maior item da fila             |                128 KiB |
| Máximo de batches duráveis     |                    128 |
| Tentativas de envio            |                      8 |
| Circuit breaker                | 5 falhas / 30 segundos |

Para aplicativos de alto volume, comece com um perfil conservador:

```typescript
sampling: {
  traceRatio: 0.05,
  logRatio: {
    debug: 0,
    info: 0.1,
    warn: 1,
    error: 1,
    fatal: 1,
  },
},
batch: {
  maxQueueSize: 256,
  maxExportBatchSize: 32,
  scheduledDelayMillis: 3_000,
  metricExportIntervalMillis: 60_000,
},
queue: {
  maxItems: 64,
  maxBytes: 256 * 1024,
  maxItemBytes: 64 * 1024,
},
privacy: {
  maxMetricCardinality: 100,
},
```

Não existe overhead zero. Faça rollout gradual e compare um build Release de controle com o build instrumentado nos mesmos dispositivos e cenários.

---

### Segurança e privacidade

Os defaults do SDK:

- exigem HTTPS em produção;
- não capturam request ou response body;
- removem query string e fragmento de URLs;
- não capturam headers sem allow-list;
- não propagam trace headers sem allow-list de destino;
- redigem chaves e textos associados a autenticação, credenciais, pagamento, e-mail, telefone, CPF e CNPJ;
- limitam quantidade e tamanho de atributos, mensagens, stacks, métricas, batches e filas;
- pseudonimizam IDs de usuário e tenant;
- mantêm headers do Collector apenas em memória;
- usam armazenamento privado e sem backup para a fila nativa.

Para excluir atributos adicionais sem substituir a lista padrão de redaction:

```typescript
privacy: {
  urlQueryPolicy: 'drop',
  attributeFilter: (key, value) =>
    key.startsWith('internal.') ? undefined : value,
},
```

O pod iOS inclui `PrivacyInfo.xcprivacy`, mas a aplicação continua responsável por revisar o Privacy Report do Xcode, App Store Privacy, Google Play Data safety, consentimento, retenção e atributos adicionados pelo próprio negócio.

---

### Resiliência e comportamento em falhas

Observabilidade não deve controlar a disponibilidade do aplicativo. Por padrão, o SDK:

- falha de forma segura se a inicialização ou o Collector estiverem indisponíveis;
- envia em batch, com timeout, retry exponencial e jitter;
- usa circuit breaker para evitar insistência contra um backend degradado;
- mantém fila durável e limitada para conectividade intermitente;
- descarta primeiro a telemetria antiga de menor prioridade quando os limites são atingidos;
- nunca espera indefinidamente pelo Collector nem deixa a fila crescer sem limite.

Não habilite `strictInitialization` em produção. Essa opção existe para testes de integração nos quais uma configuração inválida deve falhar explicitamente.

---

### Flush, shutdown e health

```typescript
const result = await ElvenObservability.flush(5_000);
const health = ElvenObservability.health();

await ElvenObservability.shutdown(5_000);
```

`flush()` e `shutdown()` retornam:

```typescript
{
  delivered: number;
  dropped: number;
  pending: number;
  timedOut: boolean;
}
```

`health()` informa estado do SDK, disponibilidade nativa, itens e bytes na fila, drops, falhas de transporte, circuit breaker e horário do último envio bem-sucedido.

O flush ao entrar em background é best effort. Android e iOS podem suspender o JavaScript imediatamente; por isso, mantenha a fila persistente ativa e não atrase navegação, logout ou encerramento esperando telemetria.

---

### Modo de diagnóstico

Diagnóstico fica desabilitado por padrão. Habilite apenas em desenvolvimento ou durante uma validação controlada:

```typescript
diagnostics: __DEV__
  ? {
      enabled: true,
      verbose: false,
    }
  : false,
```

As mensagens são limitadas, rate-limited e redigidas. Se você configurar um `sink` próprio, não o direcione para um `console` ou logger interceptado pelo SDK, pois isso pode produzir ruído ou recursão.

---

### Como validar a integração

Gere um evento conhecido e force um flush em um build de desenvolvimento:

```typescript
ElvenObservability.event('observability.validation', {
  'validation.platform': 'mobile',
});

const result = await ElvenObservability.flush(5_000);
const health = ElvenObservability.health();
```

Valide com a equipe Elven:

1. Logs, métricas e traces chegaram para o mesmo `service.name`.
2. O evento de validação possui log e span com o mesmo trace.
3. A métrica relacionada contém exemplar, sem `trace_id` como label.
4. Ambiente, versão, build, plataforma e tela estão presentes.
5. Query strings, corpos, tokens e IDs brutos de usuário/tenant estão ausentes.
6. Chamadas ao Collector não geram spans HTTP recursivos.
7. Ao interromper a rede, a fila permanece limitada.
8. Após recuperar a conexão, a fila diminui e `lastSuccessfulExportUnixMillis` é atualizado.
9. O aplicativo continua funcionando com timeout, `429`, `503` ou Collector indisponível.

Em testes locais:

| Runtime                                     | Endpoint local          |
| ------------------------------------------- | ----------------------- |
| Android Emulator                            | `http://10.0.2.2:4318`  |
| Android com `adb reverse tcp:4318 tcp:4318` | `http://localhost:4318` |
| iOS Simulator                               | `http://localhost:4318` |

HTTP local deve existir somente em builds de desenvolvimento. Não enfraqueça a segurança de rede do binário de produção.

---

### Troubleshooting

| Sintoma                                      | Verificação                                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `nativeBridgeAvailable` é `false`            | Use Development Build ou bare, reinstale pods e reconstrua o binário. No Expo Go isso é esperado.                       |
| Nenhum sinal chega                           | Confirme TLS, DNS, roteamento do dispositivo, endpoint base e paths `/v1/*`; consulte `health()`.                       |
| HTTP spans aparecem desconectados do backend | Inclua somente a API própria em `propagateTraceHeadersTo` e confirme suporte a W3C `traceparent` no servidor.           |
| Logs depois de `await` perdem correlação     | Use `span.run()` ao iniciar o trabalho e passe `{ context: span.context }` após o `await`.                              |
| Telemetria duplicada                         | Inicialize o singleton uma vez e remova instrumentações concorrentes de console, rede, erro ou providers OpenTelemetry. |
| Fila cresce com rede ativa                   | Verifique certificado, autenticação, `429`, `5xx`, limites de payload e estado do circuit breaker.                      |
| Crash iOS não aparece imediatamente          | A entrega é controlada pelo MetricKit e deve ser testada em dispositivo real.                                           |
| HTTP local é bloqueado no Android            | Use build de desenvolvimento com regra restrita a localhost, `10.0.2.2` ou `adb reverse`.                               |

---

### Limitações conhecidas

- Expo Go não carrega o módulo nativo nem oferece fila persistente nativa.
- Algumas fronteiras assíncronas do Hermes exigem propagação explícita de contexto.
- Crashes Java/Kotlin são entregues no próximo launch; crashes NDK/POSIX não são interceptados.
- Diagnósticos iOS dependem do tempo de entrega do MetricKit.
- Flush em background ou encerramento não pode ser garantido pelo sistema operacional.
- Corpos HTTP não são capturados por decisão de segurança.
- `fetch` e XHR são automáticos; stacks nativas de rede de terceiros exigem integração própria.
- Um build bem-sucedido em simulador não substitui validação em dispositivo real.

---

### Checklist de produção

Antes do rollout:

- [ ] Endpoint HTTPS do Collector homologado.
- [ ] Nenhum token reutilizável presente no aplicativo.
- [ ] Allow-list de propagação restrita às APIs próprias.
- [ ] Sampling e limites de fila revisados para o volume esperado.
- [ ] Navegação usa nomes estáveis e sem identificadores.
- [ ] Usuário, tenant e sessão usam IDs opacos e consentidos.
- [ ] Build Android Release validado em dispositivo representativo.
- [ ] Build iOS Release e MetricKit validados em dispositivo real.
- [ ] Source maps, `mapping.txt` e dSYMs preservados por versão/build.
- [ ] Logs, exemplars e traces correlacionados no backend.
- [ ] Cenários offline, timeout, throttling e recuperação aprovados.
- [ ] Privacy Report, App Store Privacy e Google Play Data safety revisados.

---

### Referências

- [Pacote no npm](https://www.npmjs.com/package/elven-unified-observability-react-native)
- [Código-fonte e exemplos](https://github.com/leozw/elven-unified-observability-react-native)
- [Referência da API](https://github.com/leozw/elven-unified-observability-react-native/blob/main/docs/API.md)
- [Matriz de compatibilidade](https://github.com/leozw/elven-unified-observability-react-native/blob/main/COMPATIBILITY.md)
- [Segurança e privacidade](https://github.com/leozw/elven-unified-observability-react-native/blob/main/SECURITY.md)
- [Performance e budgets](https://github.com/leozw/elven-unified-observability-react-native/blob/main/PERFORMANCE.md)
- [Evidências de validação](https://github.com/leozw/elven-unified-observability-react-native/blob/main/VALIDATION.md)
- [Expo Development Builds](https://docs.expo.dev/develop/development-builds/introduction/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [OpenTelemetry OTLP](https://opentelemetry.io/docs/specs/otlp/)
- [Apple Privacy Manifest](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)
