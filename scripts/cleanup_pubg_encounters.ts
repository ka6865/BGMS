/** Removes only expired encounter caches, never personal watch evidence. */
import dotenv from 'dotenv';
import {createClient} from '@supabase/supabase-js';
if(!process.argv.includes('--apply')){
  console.log(JSON.stringify({dryRun:true,encounterRetentionDays:90,profileRetentionDays:30,maxRowsPerTable:500}));
}else{
  dotenv.config({path:'.env.local',quiet:true});
  if(process.env.PUBG_ENCOUNTER_CACHE_ENABLED!=='true')throw new Error('Encounter cache cleanup is not enabled');
  const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
  const encounter=await db.rpc('cleanup_pubg_encounter_cache').abortSignal(AbortSignal.timeout(15000));
  if(encounter.error)throw new Error(`Encounter cache cleanup failed: ${encounter.error.code}`);
  const tracking=await db.rpc('cleanup_pubg_tracking_retention').abortSignal(AbortSignal.timeout(15000));
  if(tracking.error)throw new Error(`Tracking cleanup failed: ${tracking.error.code}`);
  console.log(JSON.stringify({encounterRemoved:encounter.data,trackingRemoved:tracking.data}));
}
