// Search, explicit selection and stale-response protection using the shipped controller.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../src/resolvate/console_assets/app.js'), 'utf8');
function setup() {
  const elements = new Map(), requests = [], timers = new Map();
  function element() {
    return {value:'', hidden:true, textContent:'', children:[], listeners:{}, attrs:{},
      setAttribute(k,v) {this.attrs[k]=v;}, removeAttribute(k) {delete this.attrs[k];},
      append(...items) {this.children.push(...items);}, replaceChildren(...items) {this.children=items;},
      addEventListener(k,fn) {this.listeners[k]=fn;}, contains(target) {return target === this;},
      scrollIntoView() {},
    };
  }
  const $ = id => {if (!elements.has(id)) elements.set(id,element()); return elements.get(id);};
  let timerId=0;
  const context=vm.createContext({$,state:{account:{id:'admin'}},managedProject:{id:'a'},managementEpoch:1,
    AbortController,encodeURIComponent,
    setTimeout(fn) {timers.set(++timerId,fn);return timerId;},clearTimeout(id) {timers.delete(id);},
    node(tag,cls,text) {const e=element();e.textContent=text;e.className=cls;return e;},
    api(url,options) {return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));},
  });
  vm.runInContext(source.slice(source.indexOf('let memberSearchRequest'),source.indexOf('async function renderProjects(')),context);
  const key = name => {let prevented=false; $('member-search').listeners.keydown({key:name,preventDefault(){prevented=true;},stopPropagation(){}});return prevented;};
  return {context,$,requests,timers,key};
}
const candidates=[{id:'1',name:'Alice <test>',login:'alice'},{id:'2',name:'Bob',login:'bob'}];
async function load(f) {
  const pending=f.context.searchMembers();f.requests.at(-1).resolve(candidates);await pending;
}
test('directory loads on demand and selection does not grant access',async()=>{
  const f=setup();assert.equal(f.requests.length,0);await load(f);
  assert.equal(f.requests[0].url,'projects/a/member-candidates?q=');
  assert.equal(f.$('member-options').hidden,false);
  assert.equal(f.$('member-options').children[0].children[0].textContent,'Alice <test>');
  f.$('member-options').children[0].onclick();
  assert.equal(f.$('member-login').value,'alice');
  assert.equal(f.$('member-search').value,'Alice <test> · alice');
  assert.equal(f.$('member-options').hidden,true);
  assert.equal(f.requests.length,1);
});
test('typing clears selection, debounces searches and ignores obsolete responses',async()=>{
  const f=setup();await load(f);f.context.chooseMember(0);
  const old=f.context.searchMembers();
  f.$('member-search').value='b';f.$('member-search').listeners.input();
  f.$('member-search').value='bob';f.$('member-search').listeners.input();
  assert.equal(f.$('member-login').value,'');assert.equal(f.timers.size,1);
  assert.equal(f.requests.at(-1).options.signal.aborted,true);
  f.requests.at(-1).resolve(candidates);await old;
  assert.equal(f.$('member-options').hidden,true);
  const pending=[...f.timers.values()][0]();
  assert.equal(f.requests.at(-1).url,'projects/a/member-candidates?q=bob');
  f.requests.at(-1).resolve([candidates[1]]);await pending;
  assert.equal(f.$('member-options').children.length,1);
});
test('project change, close and logout discard pending directory results',async()=>{
  for (const action of ['project','close','logout']) {
    const f=setup();const pending=f.context.searchMembers();
    if(action==='project') {f.context.managementEpoch++;f.context.managedProject={id:'b'};}
    else if(action==='close') f.context.closeMemberPicker();
    else f.context.state.account=null;
    f.requests[0].resolve(candidates);await pending;
    assert.equal(f.$('member-options').hidden,true);
    assert.equal(f.$('member-options').children.length,0);
  }
});
test('keyboard selects explicitly, Escape closes, and empty/error states are explained',async()=>{
  const f=setup();await load(f);
  assert(f.key('ArrowUp'));assert.equal(f.$('member-search').attrs['aria-activedescendant'],'member-option-1');
  assert(f.key('Enter'));assert.equal(f.$('member-login').value,'bob');
  await load(f);assert(f.key('Escape'));assert.equal(f.$('member-options').hidden,true);
  f.context.resetMemberPicker();assert.equal(f.$('member-login').value,'');
  let pending=f.context.searchMembers();f.requests.at(-1).resolve([]);await pending;
  assert.match(f.$('member-search-status').textContent,/Нет доступных/);
  pending=f.context.searchMembers();f.requests.at(-1).reject(new Error('offline'));await pending;
  assert.match(f.$('member-search-status').textContent,/Не удалось/);
});
test('support group is a text identifier with validation, serialized as a number',()=>{
  assert(source.includes('["support_group_id", "ID группы поддержки", "text"]'));
  assert(source.includes('input.pattern = "-[0-9]+|0"'));
  const pattern=/^(?:-[0-9]+|0)$/;
  assert(pattern.test('-1001234567890'));assert(!pattern.test('100123'));
  assert(!pattern.test('-1.2'));assert(!pattern.test('-1e9'));
  const start=source.indexOf('managementForm("project-settings-form"');
  const code=source.slice(source.indexOf('  const settings = {};',start),source.indexOf('  await api(',start));
  const context=vm.createContext({form:{elements:[{name:'support_group_id',type:'text',value:'-1001234567890'}]}});
  vm.runInContext(`${code}\nglobalThis.result = settings;`,context);
  assert.equal(context.result.support_group_id,-1001234567890);
});
