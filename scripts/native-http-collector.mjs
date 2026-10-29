import http from 'node:http';
import { Buffer } from 'node:buffer';

const bodyBytes = 8 * 1024 * 1024;
const chunk = Buffer.alloc(64 * 1024, 'x');
const state = {
  requests: {},
  completed: {},
  cancelled: {},
  bytes: {},
  proof: null,
  hooks: {},
  payloadSeen: {},
};
const server = http.createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/probe-complete') {
    state.proof = new URL(request.url, 'http://127.0.0.1').searchParams.get(
      'baseline'
    );
  }
  if (path === '/stats') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(state));
    return;
  }
  state.requests[path] = (state.requests[path] ?? 0) + 1;
  state.hooks[path] = request.headers['x-elven-probe-hook'] === 'preserved';
  let body = '';
  let oversized = false;
  request.setEncoding('utf8');
  request.on('data', (data) => {
    if (oversized) return;
    if (body.length + data.length <= 131072) body += data;
    else {
      body = '';
      oversized = true;
    }
  });
  request.on('end', () => {
    if (request.method === 'POST' && body) {
      try {
        const payload = JSON.parse(body);
        state.payloadSeen[path] ||= (payload.resourceLogs ?? []).some(
          (resource) =>
            (resource.scopeLogs ?? []).some((scope) =>
              (scope.logRecords ?? []).some(
                (record) =>
                  record.body?.stringValue === 'native bounded response probe'
              )
            )
        );
      } catch {
        state.payloadSeen[path] ??= false;
      }
    }
    if (path.startsWith('/hang/')) {
      response.on('close', () => {
        state.cancelled[path] = true;
      });
      return;
    }
    if (
      path !== '/baseline' &&
      !path.startsWith('/bounded/') &&
      !path.startsWith('/retry/')
    ) {
      response.end('app-network-still-works');
      return;
    }
    response.writeHead(path.startsWith('/retry/') ? 429 : 200, {
      'content-type': 'text/plain',
      'content-length': bodyBytes,
      'retry-after': '60',
    });
    let sent = 0;
    let timer;
    const pump = () => {
      if (response.destroyed) return;
      sent += chunk.length;
      state.bytes[path] = sent;
      if (response.write(chunk)) schedule();
      else response.once('drain', schedule);
    };
    const schedule = () => {
      if (sent >= bodyBytes) {
        state.completed[path] = true;
        response.end();
      } else timer = setTimeout(pump, 2);
    };
    response.on('close', () => {
      clearTimeout(timer);
      if (sent < bodyBytes) state.cancelled[path] = true;
    });
    pump();
  });
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.listen(Number(process.argv[2] ?? 4319), '127.0.0.1', () => {
  console.log(`ELVEN_NATIVE_HTTP_COLLECTOR_READY:${server.address().port}`);
});
const stop = () => {
  server.closeAllConnections();
  server.close();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setTimeout(stop, 180_000).unref();
