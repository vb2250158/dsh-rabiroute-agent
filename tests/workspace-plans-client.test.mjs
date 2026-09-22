import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
test('event bursts let an in-flight page finish and coalesce the next refresh', async () => {
 const hooks=[], cleanups=[], calls=[], listeners={}; let cursor=0, mounted=true, scheduled=false
 const render=()=>{cursor=0; context.render()}
 const React={createElement:()=>null,useState(initial){const i=cursor++;if(!(i in hooks))hooks[i]=initial;return [hooks[i],value=>{hooks[i]=typeof value==='function'?value(hooks[i]):value;if(mounted&&!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;if(mounted)render()})}}]},useRef(initial){const i=cursor++;return hooks[i]??(hooks[i]={current:initial})},useEffect(effect,deps){const i=cursor++;if(!hooks[i]||deps.some((d,n)=>d!==hooks[i][n])){cleanups[i]?.();hooks[i]=deps;cleanups[i]=effect()}}}
 const context={React,Button:0,Input:0,Menu:0,Modal:0,URLSearchParams,AbortController,setTimeout,clearTimeout,EventSource:class{addEventListener(name,fn){listeners[name]=fn}close(){listeners.closed=true}},fetch:(url,init)=>new Promise(resolve=>calls.push({url,init,resolve}))}
 vm.createContext(context)
 const source=fs.readFileSync(new URL('../src/client-workspace-plans.js',import.meta.url),'utf8').replace(/^import .*\r?\n/gm,'').replace(/^export /gm,'')
 vm.runInContext(source+"\nthis.render=()=>RabiWorkspacePlanDialog({cwd:'C:/Fixture',t:k=>k,onClose:()=>{}})",context)
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
 const finish=call=>call.resolve({ok:true,json:async()=>({code:0,data:{items:[],total:0,facets:{statuses:[],tags:[]}}})})
 try {render();await wait(280);assert.equal(calls.length,1);listeners.open();for(let i=0;i<20;i++)listeners.changed();await wait(230);assert.equal(calls.length,1);assert.equal(calls[0].init.signal.aborted,false);finish(calls[0]);await wait(500);assert.equal(calls.length,2);finish(calls[1]);await wait(20)} finally {mounted=false;cleanups.forEach(cleanup=>cleanup?.())}
 assert.equal(listeners.closed,true)
})
