'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Sync=require('../dist/cloud-sync.js');
const clone=x=>JSON.parse(JSON.stringify(x));
const META='marge.cloud.meta.v1';
const data=value=>({version:1,value,months:{},settings:{theme:'light'},selectedMonth:'2000-01',lastExport:null});
const doc=(revision,value)=>({revision,data:data(value),updatedAt:revision*1000});
const turn=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(options={}){
  let local=clone(options.data||data(10)),busy=false,enabled=true,meaningful=options.meaningful!==false;
  const storage=new Map(options.storage||[]),timers=new Map(),writes=[],applied=[],statuses=[],delays=[];
  const control={failMetadata:false,failApply:false,failWrite:null,delayWrite:false,pendingWrite:null,writeCount:0,readCount:0,listenCount:0};
  const server=new Map(options.server||[]),subscribers=new Map();let timerId=0;
  const store={getItem:k=>storage.get(k)||null,setItem(k,v){if(control.failMetadata)throw Error('quota');storage.set(k,v);},removeItem(k){if(control.failMetadata)throw Error('storage unavailable');storage.delete(k);}};
  const adapter={
    listen(uid,next,error){control.listenCount++;const record={next,error};subscribers.set(uid,record);queueMicrotask(()=>{if(subscribers.get(uid)===record)next(clone(server.get(uid)||null));});return()=>{if(subscribers.get(uid)===record)subscribers.delete(uid);};},
    async read(uid){control.readCount++;return clone(server.get(uid)||null);},
    async write(uid,expectedRevision,content){
      writes.push({uid,expectedRevision,data:clone(content)});control.writeCount++;
      if(control.failWrite)throw control.failWrite;
      const complete=()=>{
        const current=server.get(uid)||null;
        if((current?.revision||0)!==expectedRevision)throw Object.assign(Error('concurrent write'),{code:'cloud/conflict',current:clone(current)});
        const saved={revision:expectedRevision+1,data:clone(content),updatedAt:10000+expectedRevision};
        server.set(uid,saved);subscribers.get(uid)?.next(clone(saved));return clone(saved);
      };
      if(control.delayWrite)return new Promise((resolve,reject)=>{control.pendingWrite=()=>{try{resolve(complete());}catch(e){reject(e);}};});
      return complete();
    }
  };
  let sync;
  sync=Sync.create({getData:()=>local,validate:d=>{if(!d||d.version!==1||!Number.isFinite(d.value))throw Error('invalid data');},
    applyRemote:d=>{if(control.failApply)return false;local=clone(d);applied.push(clone(d));sync.resume();return true;},
    isBusy:()=>busy,isEnabled:()=>enabled,hasLocalData:()=>meaningful,storage:store,
    setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,fn);delays.push(ms);return id;},clearTimeout:id=>timers.delete(id),now:()=>99999,
    onChange:s=>{statuses.push(s);sync?.resume();}
  });
  return {sync,adapter,storage,timers,writes,applied,statuses,server,control,delays,
    get local(){return local;},set local(v){local=clone(v);},
    set busy(v){busy=v;},set enabled(v){enabled=v;},set meaningful(v){meaningful=v;},
    async connect(uid='a'){sync.connect({uid,email:uid+'@example.test'},adapter);await turn();},
    send(uid,value){if(value===null)server.delete(uid);else server.set(uid,clone(value));subscribers.get(uid)?.next(clone(value));},
    timer(){const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());},
    listenerError(uid,error){subscribers.get(uid)?.error(error);}
  };
}

async function bound(value=10){const h=fixture({server:[['a',doc(1,value)]],data:data(value)});await h.connect();return h;}

test('canonical comparison ignores navigation/export, sorts keys and preserves nested values',()=>{
  assert.equal(Sync.fingerprint({b:2,a:1,selectedMonth:'2026-11',lastExport:'yesterday'}),Sync.fingerprint({a:1,b:2,selectedMonth:'2026-12'}));
  assert.notEqual(Sync.fingerprint({budget:[1,2]}),Sync.fingerprint({budget:[2,1]}));
  assert.notEqual(Sync.fingerprint(JSON.parse('{"__proto__":{"value":1},"a":2}')),Sync.fingerprint({a:2}));
});

test('disconnected saves do not make any network request',async()=>{
  const h=fixture();h.local=data(20);h.sync.localChanged();h.timer();await h.sync.flush();
  assert.equal(h.control.writeCount,0);assert.equal(h.control.readCount,0);assert.equal(h.sync.getStatus().phase,'disconnected');
});

test('a first account never receives existing local data until explicitly chosen',async()=>{
  const h=fixture();await h.connect();h.timer();await turn();
  assert.equal(h.sync.getStatus().conflict.reason,'first-connection');assert.equal(h.control.writeCount,0);
  assert.equal(await h.sync.chooseLocal(0),true);
  assert.equal(h.server.get('a').data.value,10);assert.equal(h.server.get('a').revision,1);
  assert.equal(h.sync.getStatus().dirty,false);assert.equal(h.sync.getStatus().phase,'ready');
});

test('a fresh device restores the remote budget without uploading its empty defaults',async()=>{
  const h=fixture({data:data(0),meaningful:false,server:[['a',doc(4,50)]]});await h.connect();
  assert.equal(h.local.value,50);assert.equal(h.applied.length,1);assert.equal(h.control.writeCount,0);
  assert.equal(h.sync.getStatus().baseRevision,4);assert.equal(h.sync.getStatus().phase,'ready');
});

test('two existing versions require an explicit choice and reject a stale review revision',async()=>{
  const h=fixture({server:[['a',doc(2,30)]]});await h.connect();
  assert.equal(h.local.value,10);assert.equal(h.sync.getStatus().phase,'conflict');
  h.send('a',doc(3,40));assert.equal(h.sync.chooseRemote(2),false);assert.equal(h.local.value,10);
  assert.equal(await h.sync.chooseLocal(2),false);assert.equal(h.control.writeCount,0);
  assert.equal(h.sync.chooseRemote(3),true);assert.equal(h.local.value,40);
});

test('rapid explicit saves are debounced and navigation alone never writes',async()=>{
  const h=await bound();h.local={...h.local,selectedMonth:'2028-06',lastExport:'now'};h.sync.localChanged();
  assert.equal(h.timers.size,0);
  for(const value of [11,12,13]){h.local={...h.local,value};h.sync.localChanged();}
  assert.equal(h.timers.size,1);assert.equal(h.control.writeCount,0);
  h.timer();await turn();
  assert.equal(h.control.writeCount,1);assert.equal(h.server.get('a').data.value,13);assert.equal(h.sync.getStatus().dirty,false);
});

test('a clean device receives another device update, but an open form delays replacement',async()=>{
  const h=await bound();h.busy=true;h.send('a',doc(2,20));
  assert.equal(h.local.value,10);assert.equal(h.sync.getStatus().remotePending,true);
  h.sync.resume();assert.equal(h.local.value,10);
  h.busy=false;h.sync.resume();
  assert.equal(h.local.value,20);assert.equal(h.sync.getStatus().remotePending,false);assert.equal(h.control.writeCount,0);
});

test('saving an open form while a remote update waits produces a conflict instead of replacing it',async()=>{
  const h=await bound();h.busy=true;h.send('a',doc(2,20));h.local=data(30);h.sync.localChanged();h.busy=false;h.sync.resume();
  assert.equal(h.local.value,30);assert.equal(h.sync.getStatus().conflict.reason,'changed-both');assert.equal(h.control.writeCount,0);
});

test('a CAS race cannot overwrite a newer server revision',async()=>{
  const h=await bound();h.local=data(20);h.sync.localChanged();h.server.set('a',doc(2,90));
  assert.equal(await h.sync.flush(),false);assert.equal(h.server.get('a').data.value,90);
  assert.equal(h.sync.getStatus().phase,'conflict');assert.equal(h.local.value,20);
  assert.equal(await h.sync.chooseLocal(2),true);assert.equal(h.server.get('a').revision,3);assert.equal(h.server.get('a').data.value,20);
});

test('an edit during an in-flight write stays dirty and is written afterwards',async()=>{
  const h=await bound();h.control.delayWrite=true;h.local=data(20);h.sync.localChanged();
  const pending=h.sync.flush();await turn();h.local=data(30);h.sync.localChanged();
  h.control.pendingWrite();assert.equal(await pending,true);
  assert.equal(h.server.get('a').data.value,20);assert.equal(h.local.value,30);assert.equal(h.sync.getStatus().dirty,true);
  h.control.delayWrite=false;h.timer();await turn();assert.equal(h.server.get('a').data.value,30);assert.equal(h.sync.getStatus().dirty,false);
});

test('dirty local work survives a reload and resumes against its persisted revision',async()=>{
  const h=await bound();h.local=data(20);h.sync.localChanged();h.sync.destroy();
  const reloaded=fixture({data:h.local,storage:[...h.storage],server:[...h.server]});await reloaded.connect();
  assert.equal(reloaded.sync.getStatus().dirty,true);assert.equal(reloaded.timers.size,1);
  reloaded.timer();await turn();assert.equal(reloaded.server.get('a').data.value,20);assert.equal(reloaded.server.get('a').revision,2);
});

test('offline work plus a remote change on reload asks which version to keep',async()=>{
  const h=await bound();h.local=data(20);h.sync.localChanged();h.sync.destroy();
  const reloaded=fixture({data:h.local,storage:[...h.storage],server:[['a',doc(2,30)]]});await reloaded.connect();
  assert.equal(reloaded.sync.getStatus().conflict.reason,'changed-both');assert.equal(reloaded.local.value,20);assert.equal(reloaded.control.writeCount,0);
});

test('switching Google accounts never uploads the prior account data automatically',async()=>{
  const h=await bound();h.sync.disconnect();await h.connect('b');
  assert.equal(h.sync.getStatus().conflict.reason,'account-change');h.timer();await turn();assert.equal(h.control.writeCount,0);
  assert.equal(h.sync.getStatus().lastSynced,null);
  assert.equal(h.local.value,10);assert.equal(h.server.has('b'),false);
});

test('a disabled demo stops sync and does not consume demo changes',async()=>{
  const h=await bound();h.enabled=false;h.sync.resume();h.local=data(999);h.sync.localChanged();h.timer();
  assert.equal(await h.sync.flush(),false);assert.equal(h.control.writeCount,0);assert.equal(h.sync.getStatus().phase,'paused');
  h.local=data(10);h.enabled=true;h.sync.resume();await turn();assert.equal(h.control.writeCount,0);assert.equal(h.sync.getStatus().phase,'ready');
});

test('a metadata persistence failure stops cloud writes and never discards the local budget',async()=>{
  const h=await bound();h.control.failMetadata=true;h.local=data(20);h.sync.localChanged();h.timer();
  assert.equal(await h.sync.flush(),false);assert.equal(h.control.writeCount,0);assert.equal(h.local.value,20);
  assert.equal(h.sync.getStatus().phase,'error');assert.match(h.sync.getStatus().error,/suspendue/);
});

test('a failed local restore keeps its old synchronization baseline',async()=>{
  const h=await bound();h.control.failApply=true;h.send('a',doc(2,20));
  assert.equal(h.local.value,10);assert.equal(h.sync.getStatus().baseRevision,1);assert.equal(h.sync.getStatus().phase,'error');
});

test('network failure leaves work pending without a retry loop; an explicit retry can succeed',async()=>{
  const h=await bound();h.local=data(20);h.sync.localChanged();h.control.failWrite=Object.assign(Error('offline'),{code:'unavailable'});
  assert.equal(await h.sync.flush(),false);assert.equal(h.sync.getStatus().phase,'offline');assert.equal(h.timers.size,0);assert.equal(h.local.value,20);
  h.sync.resume();assert.equal(h.timers.size,0);h.control.failWrite=null;
  assert.equal(await h.sync.flush(),true);assert.equal(h.server.get('a').data.value,20);
});

test('remote deletion does not silently recreate the document',async()=>{
  const h=await bound();h.send('a',null);h.timer();await turn();
  assert.equal(h.sync.getStatus().conflict.reason,'remote-deleted');assert.equal(h.control.writeCount,0);assert.equal(h.sync.chooseRemote(0),false);
  assert.equal(await h.sync.chooseLocal(0),true);assert.equal(h.server.get('a').data.value,10);
});

test('late write completion from a signed-out account does not bind the next account',async()=>{
  const h=await bound();h.control.delayWrite=true;h.local=data(20);h.sync.localChanged();const pending=h.sync.flush();await turn();
  h.sync.disconnect();await h.connect('b');h.control.pendingWrite();assert.equal(await pending,false);
  assert.equal(h.sync.getStatus().user.uid,'b');assert.equal(h.sync.getStatus().phase,'conflict');assert.equal(h.server.has('b'),false);
});

test('invalid remote data and corrupted metadata never overwrite local data',async()=>{
  const h=fixture({server:[['a',{revision:2,data:{version:1,value:'bad'}}]]});await h.connect();
  assert.equal(h.local.value,10);assert.equal(h.sync.getStatus().phase,'error');assert.equal(h.control.writeCount,0);
  const broken=fixture({storage:[[META,'{broken']],server:[['a',doc(1,20)]]});await broken.connect();
  assert.equal(broken.local.value,10);assert.equal(broken.sync.getStatus().phase,'error');assert.equal(broken.control.writeCount,0);
});

test('listener errors can be retried explicitly and restore the realtime subscription',async()=>{
  const h=await bound();h.listenerError('a',{code:'unavailable'});assert.equal(h.sync.getStatus().phase,'offline');
  await h.sync.flush();await turn();h.send('a',doc(2,25));assert.equal(h.local.value,25);
});

test('an explicit local choice cannot approve a newer revision discovered during a retry',async()=>{
  const h=await bound();h.local=data(20);h.sync.localChanged();
  h.listenerError('a',{code:'unavailable'});h.server.set('a',doc(2,90));
  assert.equal(await h.sync.chooseLocal(1),false);
  assert.equal(h.control.writeCount,0);assert.equal(h.server.get('a').data.value,90);
  assert.equal(h.sync.getStatus().conflict.reason,'changed-remotely');
});

test('a delayed old read cannot regress a newer baseline or clear a local edit',async()=>{
  const h=await bound();h.listenerError('a',{code:'unavailable'});
  let finishRead;h.adapter.read=()=>new Promise(resolve=>{finishRead=resolve;});
  const pending=h.sync.flush();await turn();
  h.server.set('a',doc(3,30));h.sync.resume();await turn();
  assert.equal(h.sync.getStatus().baseRevision,3);assert.equal(h.local.value,30);
  h.local=data(20);h.sync.localChanged();finishRead(doc(2,20));
  assert.equal(await pending,true);
  assert.equal(h.writes[0].expectedRevision,3);assert.equal(h.server.get('a').revision,4);
  assert.equal(h.server.get('a').data.value,20);assert.equal(h.sync.getStatus().baseRevision,4);
});

test('an old listener value cannot roll back an already observed higher revision',async()=>{
  const h=await bound();h.send('a',doc(3,30));h.local=data(20);h.sync.localChanged();
  h.send('a',doc(2,20));
  assert.equal(h.sync.getStatus().baseRevision,3);assert.equal(h.sync.getStatus().remoteRevision,3);
  assert.equal(h.sync.getStatus().dirty,true);assert.equal(h.local.value,20);
  h.send('a',doc(4,40));assert.equal(h.sync.getStatus().phase,'conflict');assert.equal(h.local.value,20);
});

test('a server revision older than the persisted baseline requires review even when values match',async()=>{
  const h=await bound();h.send('a',doc(3,30));h.local=data(20);h.sync.localChanged();h.sync.destroy();
  const next=fixture({data:h.local,storage:[...h.storage],server:[['a',doc(2,20)]]});await next.connect();
  assert.equal(next.sync.getStatus().baseRevision,3);assert.equal(next.sync.getStatus().dirty,true);
  assert.equal(next.sync.getStatus().phase,'conflict');assert.equal(next.local.value,20);
});

test('autosave waits three minutes; navigation, exports and rendering do not postpone it',async()=>{
  const h=await bound();h.local=data(20);h.sync.localChanged();
  assert.deepEqual(h.delays,[180000]);const firstTimer=[...h.timers.keys()][0];
  for(let i=0;i<5;i++){h.local={...h.local,selectedMonth:'2027-0'+(i+1),lastExport:String(i)};h.sync.localChanged();h.sync.resume();}
  assert.deepEqual([...h.timers.keys()],[firstTimer]);assert.deepEqual(h.delays,[180000]);
  h.local={...h.local,value:30};h.sync.localChanged();assert.notEqual([...h.timers.keys()][0],firstTimer);
  assert.deepEqual(h.delays,[180000,180000]);
  h.timer();await turn();assert.equal(h.control.writeCount,1);assert.equal(h.server.get('a').data.value,30);
});

test('clean manual sync and repeated renders perform no reads, writes or duplicate listeners',async()=>{
  const h=await bound();
  for(let i=0;i<5;i++){h.sync.resume();h.sync.localChanged();assert.equal(await h.sync.flush(),true);}
  assert.equal(h.control.readCount,0);assert.equal(h.control.writeCount,0);assert.equal(h.control.listenCount,1);assert.equal(h.timers.size,0);
});

test('forgetting a disconnected local reference lets a reset device restore cloud data safely',async()=>{
  const h=await bound();assert.equal(h.sync.forgetLocalReference(),false);
  h.sync.disconnect();assert.equal(h.sync.forgetLocalReference(),true);assert.equal(h.storage.has(META),false);
  h.local=data(0);h.meaningful=false;h.sync.localChanged();await h.connect();
  assert.equal(h.local.value,10);assert.equal(h.control.writeCount,0);assert.equal(h.sync.getStatus().phase,'ready');
});

test('a failed reference reset retains its prior metadata and reports failure',async()=>{
  const h=await bound();h.sync.disconnect();const saved=h.storage.get(META);h.control.failMetadata=true;
  assert.equal(h.sync.forgetLocalReference(),false);assert.equal(h.storage.get(META),saved);assert.equal(h.local.value,10);
});
