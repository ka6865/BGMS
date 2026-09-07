import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {acquireCalculationUpgradeCheckpointLock} from './calculation_upgrade_checkpoint';
/** Locally coordinated rollout workers may prepare independently; RPC writes remain sequential. */
export async function withCalculationUpgradeWriteLock<T>(project:string,operation:()=>Promise<T>,lockRoot=tmpdir()):Promise<T>{
  if(!/^[a-z0-9.-]+$/.test(project))throw new Error('invalid_write_lock_project');
  const path=join(lockRoot,`bgms-calculation-write-${project}`),deadline=Date.now()+35000;
  let lock;
  while(!lock){
    try{lock=await acquireCalculationUpgradeCheckpointLock(path);}
    catch(error:any){if(error.message!=='calculation_upgrade_checkpoint_locked'||Date.now()>=deadline)throw error;await delay(100);}
  }
  try{return await operation();}finally{await lock.release();}
}
