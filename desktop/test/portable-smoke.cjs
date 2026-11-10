'use strict';
// The NSIS portable launcher doesn't forward Electron inspector output to
// Playwright. Connect to Chromium's local debugging port after extraction.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-output');
fs.mkdirSync(out,{recursive:true});
const data=fs.mkdtempSync(path.join(out,'portable-profile-'));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(path.join(root,'dist/TPlan-Pet-0.1.0-Windows.exe'),['--pet-only','--test-data='+data,'--remote-debugging-port=0'],{env,windowsHide:true,stdio:'ignore'});
let browser;
(async()=>{try{
 const file=path.join(data,'DevToolsActivePort'),deadline=Date.now()+60000;
 while(!fs.existsSync(file)){if(Date.now()>deadline)throw Error('便携启动器 60 秒内没有启动 Chromium');await new Promise(r=>setTimeout(r,300));}
 const port=fs.readFileSync(file,'utf8').split(/\r?\n/)[0];
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
 const pet=browser.contexts()[0].pages()[0];
 await pet.waitForFunction(()=>window.__petInfo?.().packLoaded && window.__petInfo().assetState==='idle');
 assert.equal(await pet.evaluate(()=>window.__petInfo().assetState),'idle');
 await pet.evaluate(()=>window.__petClickCharacter());
 await pet.waitForSelector('#bubble:not([hidden])');
 await pet.screenshot({path:path.join(out,'06-portable-launch.png'),omitBackground:true});
 assert.ok(fs.existsSync(path.join(data,'state.json')));
 const report={ok:true,at:new Date().toISOString(),checks:['便携 EXE 解压并启动实际程序','默认角色包显示成功','点击角色打开任务气泡','独立测试目录写入成功'],scope:'启动器 smoke；完整学习流程见 Windows 打包程序测试。'};
 fs.writeFileSync(path.join(out,'portable-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(e){console.error(e);process.exitCode=1;}finally{
 if(browser)await browser.close();
 // Only the process tree started above, using its known PID and isolated data.
 if(child.pid)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
}})();
