import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspacePlanStore } from '../src/client-workspace-plan-store.js'
import { workspacePageDelta } from '../src/workspace-plan-delta.js'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const params = { query: '', status: '', tag: '', sort: 'status', view: '', cursor: '' }
const row = (id, title=id) => ({ id, roleId: 'role', title, currentStep: 'step', presentation: { label: 'Working' }, sessions: [{ id: 'session-'+id }] })
const page = items => ({ items, roleIds: ['role'], total: items.length, nextCursor: '', facets: { statuses: [], tags: [] }, cacheMaxPages: 2, eventDelayMs: 1 })
function fixture() {
 let stream, value=page([row('a'),row('b')]), fail=false
 const calls=[], patches=[]
 class Stream extends EventTarget { constructor(){super();stream=this} close(){this.closed=true} }
 const store=createWorkspacePlanStore({Stream,debounceMs:0,fetcher:async(url,init)=>{
  calls.push({url,init});if(fail)return Response.json({code:-1,message:'Unavailable'},{status:503})
  const patch=workspacePageDelta(value,new URL(url,'http://local').searchParams);patches.push(patch)
  return Response.json({code:0,data:patch})
 }})
 return {store,calls,patches,get stream(){return stream},set value(v){value=v},set fail(v){fail=v},emit(data){stream.dispatchEvent(new MessageEvent('changed',{data:JSON.stringify(data)}))}}
}
test('cached reopening makes no request; an unrelated role does not invalidate the page',async()=>{
 const f=fixture();const release=f.store.watch('C:/Work',params,()=>{});await wait(20)
 const initial=f.store.snapshot('C:/Work',params).data;release()
 const again=f.store.watch('C:/Work',params,()=>{});await wait(20);assert.equal(f.calls.length,1);assert.equal(f.store.snapshot('C:/Work',params).data,initial)
 f.emit({type:'plan_changed',roleId:'other',planId:'a'});await wait(20);assert.equal(f.calls.length,1)
 again();f.store.dispose();assert.equal(f.stream.closed,true)
})
test('only changed rows transfer; unchanged objects survive updates, insertion, deletion and ordering',async()=>{
 const f=fixture();const release=f.store.watch('C:/Work',params,()=>{});await wait(20)
 const original=f.store.snapshot('C:/Work',params).data
 f.value=page([row('a','changed'),row('b')]);f.emit({type:'plan_changed',roleId:'role',planId:'a'});await wait(20)
 const next=f.store.snapshot('C:/Work',params).data
 assert.equal(f.patches.at(-1).items.length,1);assert.equal(next.items[1],original.items[1]);assert.equal(next.items[0].title,'changed')
 f.value=page([row('c'),row('b')]);f.emit({type:'plan_changed',roleId:'role',planId:'c'});await wait(20)
 assert.deepEqual(f.store.snapshot('C:/Work',params).data.items.map(x=>x.id),['c','b']);assert.equal(f.patches.at(-1).items.length,1)
 const stable=f.store.snapshot('C:/Work',params).data
 f.emit({type:'plan_changed',roleId:'role',planId:'outside-page'});await wait(20)
 assert.equal(f.patches.at(-1).items.length,0);assert.equal(f.patches.at(-1).meta,undefined);assert.equal(f.patches.at(-1).order,undefined);assert.equal(f.store.snapshot('C:/Work',params).data,stable)
 release();f.store.dispose()
})
test('inactive pages defer reads, reconnect reconciles, failures preserve cached rows',async()=>{
 const f=fixture();let release=f.store.watch('C:/Work',params,()=>{});await wait(20);release()
 f.value=page([row('a','new')]);f.emit({type:'plan_changed',roleId:'role',planId:'a'});await wait(20);assert.equal(f.calls.length,1)
 release=f.store.watch('C:/Work',params,()=>{});await wait(20);assert.equal(f.store.snapshot('C:/Work',params).data.items[0].title,'new')
 f.fail=true;f.emit({type:'plan_changed',roleId:'role',planId:'a'});await wait(20);assert.match(f.store.snapshot('C:/Work',params).error,/Unavailable/);assert.equal(f.store.snapshot('C:/Work',params).data.items[0].title,'new')
 f.fail=false;f.stream.dispatchEvent(new Event('error'));f.emit({type:'ready'});await wait(20);assert.equal(f.store.snapshot('C:/Work',params).error,'')
 release();f.store.dispose()
})
test('delta input is bounded and corrupted revisions are rejected',()=>{
 assert.throws(()=>workspacePageDelta(page([]),new URLSearchParams({known:'["bad"]'})),/revisions/)
})
test('event bursts preserve an in-flight read and queue one reconciliation',async()=>{
 let stream, finish
 const calls=[]
 class Stream extends EventTarget {constructor(){super();stream=this}close(){}}
 const store=createWorkspacePlanStore({Stream,debounceMs:0,fetcher:(url,init)=>new Promise(resolve=>{calls.push({url,init});finish=()=>resolve(Response.json({code:0,data:workspacePageDelta(page([row('a')]),new URL(url,'http://local').searchParams)}))})})
 const release=store.watch('C:/Work',params,()=>{});await wait(10)
 for(let i=0;i<20;i++)stream.dispatchEvent(new MessageEvent('changed',{data:'{"type":"plan_changed","roleId":"role","planId":"a"}'}))
 await wait(220);assert.equal(calls.length,1);assert.equal(calls[0].init.signal.aborted,false)
 finish();await wait(20);assert.equal(calls.length,2);finish();await wait(10);release();store.dispose()
})
test('inactive least-recently-used pages are bounded by server policy',async()=>{
 const f=fixture()
 for(const query of ['one','two','three']){const release=f.store.watch('C:/Work',{...params,query},()=>{});await wait(20);release()}
 assert.equal(f.store.snapshot('C:/Work',{...params,query:'one'}).data,null)
 assert.ok(f.store.snapshot('C:/Work',{...params,query:'three'}).data)
 f.store.dispose()
})
