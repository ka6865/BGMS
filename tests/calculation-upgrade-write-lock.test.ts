import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {withCalculationUpgradeWriteLock} from '../scripts/calculation_upgrade_write_lock';
it('serializes independent workers and releases the write lock after a failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bgms-write-lock-test-'));let active=0,peak=0;
 try{
  await Promise.all([0,1].map(()=>withCalculationUpgradeWriteLock('test',async()=>{active++;peak=Math.max(peak,active);await delay(20);active--;},dir)));
  expect(peak).toBe(1);
  await expect(withCalculationUpgradeWriteLock('test',async()=>{throw new Error('database timeout');},dir)).rejects.toThrow('database timeout');
  await expect(withCalculationUpgradeWriteLock('test',async()=>42,dir)).resolves.toBe(42);
 }finally{await rm(dir,{recursive:true,force:true});}
});
