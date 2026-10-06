// Exercise the shipped navigation functions with controlled, out-of-order responses.
// No npm dependencies or network access are required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../src/resolvate/console_assets/app.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function setup() {
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, value: '', textContent: '', hidden: false, disabled: false,
      scrollTop: 0, scrollHeight: 500, clientHeight: 500, children: [],
      classList: {add() {}, remove() {}, toggle() {}},
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
      replaceChildren(...children) { this.children = children; },
      querySelectorAll() { return this.children; }, getClientRects() { return [{}]; },
      close() {}, focus() { this.focused = true; },
    });
    return elements.get(id);
  };
  const requests = [], errors = [];
  const state = {
    ticket: null, detail: null, project: 'project-a', account: {}, epoch: 0,
    detailRequest: 0, messageRequest: 0, listEpoch: 0, searchEpoch: 0,
    messages: new Map(), tickets: new Map(), drafts: new Map(), chatCache: new Map(),
    historyUpdatedAt: 0, before: null, older: false, opening: null,
  };
  const context = vm.createContext({
    state, $, Map, Date, AbortController, document: {hidden: false},
    imageViewer: {close() {}}, saveDraft() {}, draft: () => ({text: ''}),
    renderTicketFolder() {}, renderFile() {}, resizeComposer() {},
    resetFolders() {}, renderProjectLogo() {}, closePassword() {}, notice() {},
    startEvents() {}, stopEvents() {},
    fail: error => errors.push(error),
    known: map => Object.fromEntries([...map].map(([id, item]) => [id, item.revision])),
    renderDetail: detail => { $('customer-name').textContent = detail.display_name || 'Клиент'; },
    renderMessages: () => {
      const items = [...state.messages.values()];
      $('message-list').replaceChildren(...items);
      return items;
    },
    api: (url, options = {}) => new Promise((resolve, reject) => requests.push({url, options, resolve, reject})),
  });
  vm.runInContext([
    section('async function openTicket(', 'function renderDetail('),
    section('async function syncMessages(', 'function renderMessages('),
    section('function selectProject(', 'function logoSource('),
    section('function showLogin(', 'async function enter('),
  ].join('\n'), context);
  return {context, state, $, requests, errors};
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const item = (id, text = id) => ({id, text, revision: text, time: '2026-01-01T00:00:00Z'});
const page = (items = [], extra = {}) => ({items, removed: [], before: 'cursor', has_older: false, ...extra});
async function finish(fixture, id, items = [item(id)]) {
  const {requests} = fixture;
  requests.findLast(r => r.url === `tickets/${id}`).resolve({display_name: id, status: 'open'});
  requests.findLast(r => r.url === `tickets/${id}/sync`).resolve(page(items));
  await flush();
}

test('selects immediately; detail/history run in parallel; receipts do not block opening', async () => {
  const f = setup();
  const button = f.$('button-a'); button.dataset.id = 'a';
  f.$('ticket-list').children = [button];
  f.state.tickets.set('a', {name: 'Preview A'});
  const opening = f.context.openTicket('a');
  assert.equal(button['aria-current'], 'true');
  assert.equal(f.$('customer-name').textContent, 'Preview A');
  assert.deepEqual(f.requests.map(r => r.url), ['tickets/a', 'tickets/a/sync']);
  f.requests[1].resolve(page([item('a')]));
  await flush();
  assert.equal(f.$('message-list').children[0].id, 'a');
  assert.equal(f.state.detail, null);
  f.requests[0].resolve({display_name: 'A'});
  await opening;
  assert.equal(f.state.opening, null);
  assert.deepEqual(f.requests.map(r => r.url), ['tickets/a', 'tickets/a/sync', 'tickets/a/read/a']);
});

test('cached history appears before network; revalidation applies edits and removals', async () => {
  const f = setup();
  let opening = f.context.openTicket('a'); await finish(f, 'a'); await opening;
  opening = f.context.openTicket('b'); await finish(f, 'b'); await opening;
  opening = f.context.openTicket('a');
  assert.equal(f.$('message-list').children[0].id, 'a');
  assert.equal(f.$('lifecycle').disabled, true);
  const request = f.requests.findLast(r => r.url === 'tickets/a/sync');
  assert.equal(request.options.data.known.a, 'a');
  f.requests.findLast(r => r.url === 'tickets/a').resolve({display_name: 'A updated'});
  request.resolve(page([item('new')], {removed: ['a']}));
  await opening;
  assert.deepEqual([...f.state.messages.keys()], ['new']);
  assert.equal(f.$('lifecycle').disabled, false);
});

test('fast switches abort obsolete requests and ignore late responses, even returning to same chat', async () => {
  const f = setup();
  const first = f.context.openTicket('a'), old = [...f.requests];
  const second = f.context.openTicket('b');
  const third = f.context.openTicket('a');
  assert.equal(old[0].options.signal.aborted, true);
  await finish(f, 'a', [item('fresh')]); await third;
  old[0].resolve({display_name: 'Wrong'}); old[1].resolve(page([item('stale')]));
  await finish(f, 'b'); await Promise.all([first, second]);
  assert.deepEqual([...f.state.messages.keys()], ['fresh']);
  assert.equal(f.$('customer-name').textContent, 'a');
});

test('project change and logout clear cache and cannot be repopulated by in-flight responses', async () => {
  for (const reset of ['selectProject', 'showLogin']) {
    const f = setup();
    let opening = f.context.openTicket('a'); await finish(f, 'a'); await opening;
    opening = f.context.openTicket('b');
    assert.equal(f.state.chatCache.size, 1);
    f.context[reset]('project-b');
    await finish(f, 'b'); await opening;
    assert.equal(f.state.chatCache.size, 0);
    assert.equal(f.state.messages.size, 0);
    assert.equal(f.$('message-list').children.length, 0);
    assert.equal(f.state.ticket, null);
  }
});

test('denied revalidation removes cached content and disables ticket actions', async () => {
  const f = setup();
  let opening = f.context.openTicket('a'); await finish(f, 'a'); await opening;
  opening = f.context.openTicket('a');
  f.requests.findLast(r => r.url === 'tickets/a').reject(Object.assign(new Error('Denied'), {status: 403}));
  await assert.rejects(opening, /Denied/);
  f.requests.findLast(r => r.url === 'tickets/a/sync').resolve(page([item('late')]));
  await flush();
  assert.equal(f.state.chatCache.size, 0);
  assert.equal(f.state.messages.size, 0);
  assert.equal(f.$('lifecycle').disabled, true);
});

test('cache is bounded, expires, and does not refresh expiry merely on navigation', async () => {
  const f = setup();
  for (let index = 0; index < 25; index++) {
    Object.assign(f.state, {ticket: String(index), historyUpdatedAt: Date.now() - 130000});
    f.context.rememberChat();
  }
  assert.equal(f.state.chatCache.size, 20);
  const opening = f.context.openTicket('24');
  assert.equal(f.state.historyUpdatedAt, 0);
  assert.equal(f.state.messages.size, 0);
  await finish(f, '24'); await opening;
  f.state.messages = new Map(Array.from({length: 201}, (_, i) => [String(i), item(String(i))]));
  f.context.rememberChat();
  assert.equal(f.state.chatCache.has('24'), false);
});

test('cached pagination cursor is retained and explicit server reset replaces history', async () => {
  const f = setup();
  Object.assign(f.state, {ticket: 'a', historyUpdatedAt: Date.now(), before: 'oldest', older: true});
  f.state.messages.set('old', item('old'));
  const opening = f.context.openTicket('a');
  await finish(f, 'a'); await opening;
  assert.equal(f.state.before, 'oldest');
  assert.equal(f.state.older, true);
  const sync = f.context.syncMessages();
  f.requests.findLast(r => r.url === 'tickets/a/sync').resolve(page([item('new')], {reset: true}));
  await sync;
  assert.deepEqual([...f.state.messages.keys()], ['new']);
  assert.equal(f.state.before, 'cursor');
});

test('out-of-order refreshes do not revert newer history', async () => {
  const f = setup(); f.state.ticket = 'a';
  const first = f.context.syncMessages(), second = f.context.syncMessages();
  f.requests[1].resolve(page([item('new')])); await second;
  f.requests[0].resolve(page([item('old')])); await first;
  assert.deepEqual([...f.state.messages.keys()], ['new']);
});
