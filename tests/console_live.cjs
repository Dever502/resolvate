const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../src/resolvate/console_assets/app.js'), 'utf8');
const code = source.slice(source.indexOf('let eventSource = null;'), source.lastIndexOf('api("me")'));

function setup() {
  const timers = new Map(), sources = [], requests = [];
  const state = {account:{id:'operator'}, project:'a', ticket:'ticket', epoch:0};
  let next = 0;
  class FakeSource {
    static CLOSED = 2;
    constructor(url) { this.url = url; this.listeners = {}; this.readyState = 1; sources.push(this); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    emit(name, data = {}) { this.listeners[name]?.({data:JSON.stringify(data)}); }
    close() { this.closed = true; }
  }
  const document = {hidden:false, listeners:{}, addEventListener(name, listener) {this.listeners[name] = listener;}};
  const context = vm.createContext({
    state, document, window:{EventSource:FakeSource, addEventListener() {}}, EventSource:FakeSource,
    Date:{now:() => 10000},
    setTimeout(fn, delay) { const id = ++next; timers.set(id, {fn, delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    refreshProjects: async () => {requests.push('projects');},
    syncTickets: async () => {requests.push('tickets');},
    syncDetail: async () => {requests.push('detail');},
    syncMessages: async () => {requests.push('messages');},
    showLogin: () => {state.account = null;},
    selectProject: id => {state.project = id;},
    fail(error) { throw error; }, notice() {},
  });
  vm.runInContext(code, context);
  return {context, state, sources, timers, requests, document};
}

test('SSE readiness refreshes data, then uses 30-second safety polling; failure restores 3 seconds', async () => {
  const f = setup(); f.context.startEvents(); f.context.startEvents();
  assert.equal(f.sources.length, 1);
  assert.equal(f.sources[0].url, '/console/projects/a/events');
  f.sources[0].emit('ready');
  await f.context.poll();
  assert.deepEqual(f.requests, ['projects','tickets','detail','messages']);
  assert.equal([...f.timers.values()][0].delay, 30000);
  f.sources[0].onerror();
  await f.context.poll();
  assert.equal([...f.timers.values()][0].delay, 3000);
});

test('burst events coalesce and changes arriving during a refresh are not lost', async () => {
  const f = setup(); f.context.startEvents();
  for (let i = 0; i < 100; i++) f.sources[0].emit('change');
  assert.equal(f.timers.size, 1);
  f.context.syncTickets = async () => {f.sources[0].emit('change');};
  await f.context.poll();
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 500);
});

test('hidden tabs close streams, visible tabs reconnect, obsolete project events are ignored', () => {
  const f = setup(); f.context.startEvents(); const old = f.sources[0];
  f.document.hidden = true; f.document.listeners.visibilitychange();
  assert.equal(old.closed, true);
  f.state.project = 'b'; f.document.hidden = false; f.document.listeners.visibilitychange();
  assert.equal(f.sources[1].url, '/console/projects/b/events');
  old.emit('revoked', {status:401}); assert(f.state.account);
  f.sources[1].emit('revoked', {status:403});
  assert.equal(f.state.project, null);
  assert.equal(f.sources[1].closed, true);
});

test('expired session closes the stream and returns to login', () => {
  const f = setup(); f.context.startEvents();
  f.sources[0].emit('revoked', {status:401});
  assert.equal(f.state.account, null);
  assert.equal(f.sources[0].closed, true);
});

test('events do not refresh over an in-flight chat opening', async () => {
  const f = setup(); f.state.opening = {};
  f.context.requestRefresh(); await f.context.poll();
  assert.equal(f.requests.length, 0);
  assert.equal([...f.timers.values()][0].delay, 500);
  f.state.opening = null; await f.context.poll();
  assert.equal(f.requests.length, 4);
});

test('a fully closed stream retries after backoff while polling remains available', async () => {
  const f = setup(); f.context.startEvents();
  f.sources[0].readyState = 2; f.sources[0].onerror();
  await f.context.poll();
  assert.equal(f.sources.length, 1);
  assert.equal([...f.timers.values()][0].delay, 3000);
  f.context.Date.now = () => 21000;
  await f.context.poll();
  assert.equal(f.sources.length, 2);
});
