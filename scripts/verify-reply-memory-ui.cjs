const { app, BrowserWindow } = require('electron')
const esbuild = require('esbuild')
const sass = require('sass')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weflow-reply-memory-ui-'))
const windows = new Set()
app.setPath('userData', path.join(directory, 'user-data'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
const watchdog = setTimeout(() => app.exit(1), 30000)
app.whenReady().then(async () => {
  const bundle = await esbuild.build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import Panel from './src/components/ReplyAssistantPanel';
    window.fixture = { success: true, message: '仍有效' };
    window.electronAPI = { insight: { validateReplyAssistant: async () => window.fixture }, relationshipProfile: {confirmReplyPreference: async () => ({success:true,message:'已保存'})} };
    function Host() { const [result,setResult] = useState({suggestionId:'one',accountScope:'wxid:fixture',sessionId:'alice',mode:'repair',status:'draft',draft:'刚才我的语气不好，等你方便时我们再聊。',reason:'尊重当次意图和当前边界',risk:'对方意愿仍需确认',positiveFollowUp:'确认时间',ambiguousFollowUp:'先等回应',noResponsePlan:'不追问',revisionFeedback:'冲突时别说反话',proposedPreference:'修复误会时不使用反话',previousDraft:'你开心就好',historicalMemory:[{id:'archive-one',field:'communicationPreferences',value:'过去散步聊天时偏好简短表达',archivedAt:1791200000000,quotes:[],expressionExample:{previous:'一起散步！！！',approved:'一起散步吗',feedback:'少用感叹号'}}]});
      return <Panel result={result} busy={false} onChange={draft=>setResult(old=>({...old,draft}))} onGenerate={async()=>{}} onCopy={async()=>{}} onOutcome={async()=>{}} onStop={async()=>{}} onClose={()=>{}}/> }
    createRoot(document.getElementById('root')).render(<Host/>);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } })
  const css = sass.compile(path.join(process.cwd(), 'src/pages/ChatPage.scss')).css
  const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><style>${css}
    :root{--primary:#258f76;--text-primary:#222;--text-secondary:#666;--bg-secondary:#f8f9f9;--bg-tertiary:#eef0f0;--border-color:#ddd}body{margin:0;padding:16px;box-sizing:border-box;font:14px Arial,sans-serif;background:white;color:#222}#root{max-width:900px;margin:auto}.session-insight-hint{padding:12px;border:1px solid #ddd;border-radius:6px}select{max-width:100%}
    </style><div id="root"></div><script>${bundle.outputFiles[0].text}</script></html>`
  const server = http.createServer((req, res) => { console.log('fixture http', req.url); res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({ show: false, width: 1100, height: 1100, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false } })
  windows.add(window)
  for (const width of [1100, 390]) {
    window.setSize(width, 1100)
    window.webContents.on('render-process-gone', (_event, details) => console.error('fixture renderer', details))
    window.webContents.on('console-message', (event) => console.log('fixture renderer console:', event.message))
    window.webContents.on('did-fail-load', (_event, code, description, url) => console.error('fixture load', code, description, url))
    window.webContents.on('did-finish-load', () => console.log('fixture did-finish-load'))
    window.on('closed', () => console.log('fixture closed'))
    await window.loadURL(`http://127.0.0.1:${server.address().port}/`).catch(async error => {
      console.error('fixture dom', await window.webContents.executeJavaScript('({url:location.href,text:document.body?.innerText})').catch(String))
      throw error
    })
    await window.webContents.executeJavaScript(`new Promise(resolve=>{const poll=()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='复制');if(button&&!button.disabled)resolve();else setTimeout(poll,20)};poll()})`)
    await window.webContents.executeJavaScript(`for(const details of document.querySelectorAll('details')) details.open=true`)
    const ready = await window.webContents.executeJavaScript(`({fits:document.documentElement.scrollWidth<=innerWidth,text:document.body.innerText})`)
    assert.ok(ready.fits, `${width}: horizontal overflow`)
    assert.match(ready.text, /适用场景/)
    assert.match(ready.text, /参考的历史记忆/)
    fs.writeFileSync(path.join(directory, `valid-${width}.png`), (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript(`(()=>{const input=document.querySelector('[aria-label="编辑回复草稿"]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(input,'我修改过的回复');input.dispatchEvent(new Event('input',{bubbles:true}));window.fixture={success:false,stale:true,message:'有新消息，请重新生成；原草稿已保留'}})()`)
    await window.webContents.executeJavaScript(`new Promise(resolve=>{const poll=()=>{if(document.querySelector('.reply-assistant-validity')?.textContent.includes('有新消息'))resolve();else setTimeout(poll,20)};poll()})`)
    const stale = await window.webContents.executeJavaScript(`({fits:document.documentElement.scrollWidth<=innerWidth,disabled:[...document.querySelectorAll('button')].find(b=>b.textContent==='复制').disabled,value:document.querySelector('[aria-label="编辑回复草稿"]').value})`)
    assert.ok(stale.fits)
    assert.equal(stale.disabled, true)
    assert.equal(stale.value, '我修改过的回复')
    fs.writeFileSync(path.join(directory, `stale-${width}.png`), (await window.webContents.capturePage()).toPNG())
  }
  server.close()
  console.log(`Visual verification passed: ${directory}`)
  clearTimeout(watchdog)
  app.exit(0)
}).catch((error) => { console.error(error); app.exit(1) })
