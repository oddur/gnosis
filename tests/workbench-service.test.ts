import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Octokit } from '@octokit/rest';
import { createWorkbenchService } from '../src/workbench-service';
import type { Preferences } from '../lib/types';
import { DEFAULT_CLAUDE_MODEL } from '../lib/models';
import type { getProvider } from '../lib/provider';

function setup(generate:()=>Promise<string>,auto=true) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gnosis-workbench-unit-'));
 let busy=false;
 const prefs={provider:'claude',model:DEFAULT_CLAUDE_MODEL,watchedRepos:[],autoBriefings:auto,briefingDailyLimit:1} as Preferences;
 const pr={title:'Bounded queue',body:'Limit pending work',user:{login:'author'},base:{ref:'main',sha:'base',repo:{full_name:'owner/repo'}},head:{ref:'queue',sha:'head',repo:{full_name:'owner/repo'}},merged:false,state:'open',created_at:'2026-10-22',updated_at:'2026-10-22',html_url:'https://github.com/owner/repo/pull/1',labels:[],mergeable:true,draft:false,commits:1,requested_reviewers:[],requested_teams:[],mergeable_state:'clean',auto_merge:null,milestone:null};
 const client={search:{issuesAndPullRequests:async()=>({data:{items:[{number:1,title:pr.title,html_url:pr.html_url,repository_url:'https://api.github.com/repos/owner/repo',user:pr.user,updated_at:pr.updated_at,draft:false}]}})},pulls:{get:async()=>({data:pr}),list:async(args:{head?:string})=>({data:args.head?[]:[pr]}),listFiles:async()=>({data:[{filename:'queue.ts',status:'modified',additions:1,deletions:1,patch:'@@ -1 +1 @@\n-before\n+after'}]})}} as unknown as Octokit;
 const provider=(()=>({generate})) as unknown as typeof getProvider;
 const deps={directory:()=>directory,auth:()=>({token:'fixture',login:'reviewer'}),preferences:()=>prefs,history:()=>[],busy:()=>busy,client:()=>client,provider};
 return {service:createWorkbenchService(deps),deps,prefs,pr,setBusy:(value:boolean)=>{busy=value;},cleanup:()=>fs.rmSync(directory,{recursive:true,force:true})};
}
async function settle(service:ReturnType<typeof createWorkbenchService>,status:string) {
 for(let i=0;i<100;i++){const q=await service.queue();if(q.items[0]?.briefing?.status===status)return q;await new Promise(r=>setTimeout(r,10));}
 throw new Error('Briefing did not reach '+status);
}
test('briefings are cached, bounded, and survive a restart',async()=>{
 let calls=0;const s=setup(async()=>{calls++;return JSON.stringify({summary:'Bound queue growth.',systems:['Queue'],priorities:['Capacity under cancellation']});});
 try {
  await s.service.queue();const ready=await settle(s.service,'ready');
  assert.equal(ready.remaining,0);assert.equal(calls,1);
  await s.service.queue(true);assert.equal(calls,1);
  const restarted=createWorkbenchService(s.deps);await restarted.queue();assert.equal((await settle(restarted,'ready')).items[0].briefing?.summary,'Bound queue growth.');assert.equal(calls,1);
  s.pr.head.sha='new-head';const changed=await s.service.queue(true);assert.equal(changed.items[0].briefing?.status,'paused');assert.equal(calls,1);
 } finally{s.cleanup();}
});
test('foreground work and disabled automation prevent model calls',async()=>{
 let calls=0;const s=setup(async()=>{calls++;return '{"summary":"A change"}';},false);
 try {await s.service.queue();assert.equal(calls,0);s.prefs.autoBriefings=true;s.setBusy(true);await s.service.queue();assert.equal(calls,0);s.setBusy(false);await s.service.queue();await settle(s.service,'ready');assert.equal(calls,1);}finally{s.cleanup();}
});
test('provider failures leave the queue usable and consume the bounded attempt',async()=>{
 const s=setup(async()=>{throw new Error('Provider unavailable');});
 try {await s.service.queue();const failed=await settle(s.service,'failed');assert.equal(failed.items.length,1);assert.match(failed.items[0].briefing?.error??'',/Provider unavailable/);assert.equal(failed.remaining,0);}finally{s.cleanup();}
});
test('interrupted saved jobs become retryable after restart',async()=>{
 const s=setup(async()=>'{"summary":"Ready"}',false);
 try {
  await s.service.queue();const file=path.join(s.deps.directory(),'workbench.json');
  const state=JSON.parse(fs.readFileSync(file,'utf8')) as {briefs:Record<string,unknown>};
  const k=(await s.service.queue()).items[0].briefing?.key;assert.ok(k);
  state.briefs[k]={key:k,status:'generating',updatedAt:'now'};fs.writeFileSync(file,JSON.stringify(state));
  const restarted=createWorkbenchService(s.deps);const q=await restarted.queue();assert.equal(q.items[0].briefing?.status,'failed');assert.match(q.items[0].briefing?.error??'',/interrupted/);
 }finally{s.cleanup();}
});
