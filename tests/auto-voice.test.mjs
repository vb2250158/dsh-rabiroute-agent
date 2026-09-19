import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import { readRabiVoicePolicy, transcribeRabiSpeech } from '../src/speech-asr.js'

const source = (await readFile(new URL('../src/client-question.js', import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replace(/^export /gm, '')
const config = { sampleRate: 16000, chunkMs: 100, recordThreshold: .01, transcribeThreshold: .015, adaptiveThreshold: true, adaptiveMultiplier: 2.5, adaptiveMargin: .004, silenceMs: 500, minUtteranceMs: 1000, maxUtteranceMs: 60000, preRollMs: 1500, inputGain: 1, autoSubmit: true, suppressDuringPlayback: true }
const signal = () => new AbortController().signal
const wait = () => new Promise(resolve => setTimeout(resolve, 15))
function gate(over = {}) {
  return vm.runInNewContext(source + ';createRabiVoiceGate(config,16000)', { config: { ...config, ...over }, Float32Array })
}
function feed(g, volume, count) { let result; for (let i=0;i<count;i++) result = g.push(new Float32Array(1600).fill(volume)) ?? result; return result }
test('Rabi gate ignores silence and short noises, closes only after configured silence', () => {
  const g = gate()
  assert.equal(feed(g, 0, 30), undefined)
  feed(g, .1, 2); assert.equal(feed(g, 0, 5), undefined)
  feed(g, .1, 10); assert.equal(feed(g, 0, 4), undefined)
  assert.ok(feed(g, 0, 1) instanceof Float32Array)
})
test('Rabi gate follows minimum voice, gain and maximum length settings', () => {
  const g = gate({ minUtteranceMs: 200, maxUtteranceMs: 500, preRollMs: 0 })
  assert.ok(feed(g, .1, 5) instanceof Float32Array)
  assert.equal(feed(gate({ inputGain: .1 }), .02, 30), undefined)
  assert.throws(() => gate({ silenceMs: undefined }), /configuration/)
})
test('policy reads microphone and playback owners without writes or defaults', async () => {
  const calls=[]
  const result=await readRabiVoicePolicy({},signal(), { resolveManagerBase: async()=> 'http://rabi.test', fetch: async(url,init)=> { calls.push({url,init}); return Response.json({code:0,data:url.includes('microphone')?{config}:{current:'job'}}) } })
  assert.deepEqual(result,{ok:true,config,playbackActive:true})
  assert.equal(calls.length,2); assert.ok(calls.every(c=>!c.init.method))
  assert.equal((await readRabiVoicePolicy({},signal(),{resolveManagerBase:async()=>{throw new Error('offline')}})).ok,false)
})
function ui({ autoSubmit=true, recognition, permission, policyError=false }={}) {
  const dom=new JSDOM('<main><div><textarea placeholder="输入你的答案"></textarea></div></main>',{url:'http://localhost'})
  const field=dom.window.document.querySelector('textarea'); let process, stopped=0, sent=0, requests=0
  field.addEventListener('keydown',e=>{if(e.key==='Enter')sent++})
  const stream={getTracks:()=>[{stop:()=>stopped++}]}
  class Context {
    sampleRate=16000;state='running'
    resume(){return Promise.resolve()}
    close(){this.state='closed';return Promise.resolve()}
    createMediaStreamSource(){return {connect(){},disconnect(){}}}
    createGain(){return {gain:{value:0},connect(){},disconnect(){}}}
    createScriptProcessor(){process={connect(){},disconnect(){}};return process}
  }
  Object.defineProperty(dom.window.navigator,'mediaDevices',{value:{getUserMedia:()=>permission?permission:Promise.resolve(stream)}})
  dom.window.AudioContext=Context
  const ctx={window:dom.window,document:dom.window.document,navigator:dom.window.navigator,AudioContext:Context,Float32Array,Int16Array,Uint8Array,ArrayBuffer,DataView,Event:dom.window.Event,KeyboardEvent:dom.window.KeyboardEvent,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,btoa:x=>Buffer.from(x,'binary').toString('base64'),fetch:async(_url,init={})=> {
    if(!init.method)return Response.json(policyError?{ok:false,reason:'unreachable'}:{ok:true,config:{...config,autoSubmit},playbackActive:false})
    requests++;return recognition?recognition:Response.json({ok:true,text:'hello'})
  }}
  const dispose=vm.runInNewContext(source+';enhanceCustomField(document.querySelector("textarea"),{sessionId:"test",t:key=>rabiQuestionLocales.en[key]})',ctx)
  const toggle=dom.window.document.querySelector('[role=switch]')
  return {dom,field,toggle,dispose,stream,get sent(){return sent},get stopped(){return stopped},get requests(){return requests},async phrase(){for(let i=0;i<6;i++)process.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4096).fill(.1)}});for(let i=0;i<3;i++)process.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4096)}});await wait();await wait()}}
}
test('switch listens, fills official input then submits once and releases capture',async()=>{
  const h=ui();try {assert.equal(h.toggle.getAttribute('aria-checked'),'false');h.toggle.click();await wait();await h.phrase();assert.equal(h.field.value,'hello');assert.equal(h.sent,1);assert.equal(h.requests,1);assert.equal(h.stopped,1);assert.equal(h.toggle.getAttribute('aria-checked'),'false')}finally{h.dispose();h.dom.window.close()}
})
test('Rabi autoSubmit false fills text without submitting',async()=>{
  const h=ui({autoSubmit:false});try{h.toggle.click();await wait();await h.phrase();assert.equal(h.field.value,'hello');assert.equal(h.sent,0)}finally{h.dispose();h.dom.window.close()}
})
test('turning switch off discards late ASR and releases microphone',async()=>{
  let resolve;const response=new Promise(r=>resolve=r);const h=ui({recognition:response})
  try{h.toggle.click();await wait();await h.phrase();h.toggle.click();resolve(Response.json({ok:true,text:'late'}));await wait();assert.equal(h.sent,0);assert.equal(h.field.value,'');assert.equal(h.stopped,1)}finally{h.dispose();h.dom.window.close()}
})
test('closing field during permission prompt stops the late stream',async()=>{
  let resolve;const permission=new Promise(r=>resolve=r);const h=ui({permission})
  h.toggle.click();await wait();h.dispose();resolve(h.stream);await wait();assert.equal(h.stopped,1);assert.equal(h.sent,0);h.dom.window.close()
})
test('policy failure never starts listening',async()=>{
  const h=ui({policyError:true});try{h.toggle.click();await wait();assert.equal(h.toggle.getAttribute('aria-checked'),'false');assert.equal(h.requests,0)}finally{h.dispose();h.dom.window.close()}
})

test('automatic ASR uses Rabi microphone model and language instead of unrelated defaults',async()=>{
  let form
  const result=await transcribeRabiSpeech({}, {automatic:true,sessionId:'test',mimeType:'audio/wav',audio:Buffer.from('RIFF0000WAVE').toString('base64')},signal(),{
    resolveManagerBase:async()=> 'http://rabi.test',fetch:async(url,init)=> {
      if(url.endsWith('/microphone/status'))return Response.json({code:0,data:{config:{...config,asrModel:'faster-whisper/large-v3-turbo',language:'ja',prompt:'hint'}}})
      if(url.endsWith('/playback/status'))return Response.json({code:0,data:{current:null}})
      if(url.endsWith('/speech/status'))return Response.json({code:0,data:{state:'online'}})
      form=init.body;return Response.json({text:'recognized'})
    }
  })
  assert.equal(result.ok,true);assert.equal(form.get('model'),'faster-whisper/large-v3-turbo');assert.equal(form.get('language'),'ja');assert.equal(form.get('prompt'),'hint')
})
