const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export async function applyWritebacks(sync,a,signal){
 for(let n=0;n<20;n++){
  signal?.throwIfAborted();
  const job=await sync.call(a,'writebackNext');if(!job)return;
  let moveAttempted=false;
  try{
   const result=await sync.reader.execute(a,{folder:job.source_folder,validity:job.source_validity,write:true},async(client,box,check)=>{
    if(!await client.fetchOne(job.source_uid,{uid:true},{uid:true}))fail(409,'Original message no longer exists');
    const allowed=await sync.call(a,'writebackNext');if(allowed?.id!==job.id)fail(409,'Writeback cancelled');
    check();
    if(['read','unread','flag','unflag'].includes(job.action)){
     const flag=['read','unread'].includes(job.action)?'\\Seen':'\\Flagged';
     const method=['read','flag'].includes(job.action)?'messageFlagsAdd':'messageFlagsRemove';
     if(!await client[method](job.source_uid,[flag],{uid:true}))fail(502,'Flag update failed');
     return {};
    }
    const folders=(await client.list()).filter(f=>!f.flags?.has('\\Noselect'));
    let destination=job.destination;
    if(job.action!=='move'){
     const matches=folders.filter(f=>f.specialUse===(job.action==='trash'?'\\Trash':'\\Archive'));
     if(matches.length!==1)fail(409,'No unique destination folder');destination=matches[0].path;
    }
    if(!folders.some(f=>f.path===destination))fail(409,'Destination folder unavailable');
    if(destination===job.source_folder)return {};
    if(!client.capabilities?.has('MOVE')||!client.capabilities?.has('UIDPLUS'))fail(409,'Safe mapped move is not supported');
    // Recheck persistent policy immediately before a remote mutation.
    const moving=await sync.call(a,"writebackNext");if(moving?.id!==job.id)fail(409,"Writeback cancelled");
    check();
    moveAttempted=true;
    const moved=await client.messageMove(job.source_uid,destination,{uid:true});
    const uid=Number(moved?.uidMap?.get(job.source_uid));
    if(!Number.isSafeInteger(uid)||uid<1||!moved.uidValidity)fail(409,'Move outcome needs review');
    return {destination,uid,validity:String(moved.uidValidity)};
   },signal);
   await sync.call(a,'writebackComplete',{id:job.id,...result});
  }catch(e){
   signal?.throwIfAborted();
   // Never blindly retry a move with an unknown outcome; idempotent flag writes may retry.
   const blocked=moveAttempted||[400,404,409].includes(e.status);
   await sync.call(a,'writebackFailed',{id:job.id,blocked});
  }
 }
}
