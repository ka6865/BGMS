import { parseArgs } from 'node:util';
import { register } from 'node:module';
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(specifier,context,nextResolve){return specifier==='server-only'?{url:'data:text/javascript,export {}',shortCircuit:true}:nextResolve(specifier,context);}`),import.meta.url);
try {
  const {values}=parseArgs({options:{apply:{type:'boolean'},'dry-run':{type:'boolean'},check:{type:'boolean'}}});
  if((values.apply&&values['dry-run'])||(values.check&&(values.apply||values['dry-run'])))throw new Error('conflicting_mode');
  if(values.check){
    const [{createChampionSource},{getChampionDatasetReadiness}]=await Promise.all([import('../lib/lol/mayhemChampionSource'),import('../lib/lol/mayhemChampionDatasetStore.server')]);
    const version=await createChampionSource().config();
    console.log(JSON.stringify({readOnly:true,readiness:getChampionDatasetReadiness(),source:version,apiCreditsUsed:0,databaseWrites:0,storageWrites:0},null,2));
  }else{
    const {ingestChampionDataset}=await import('../lib/lol/mayhemChampionIngest.server');
    console.log(JSON.stringify(await ingestChampionDataset({apply:values.apply===true}),null,2));
  }
}catch(error){
  console.error('[lol-mayhem-champion]',error instanceof Error&&/^[a-z_]{1,80}$/.test(error.message)?error.message:'stats_sync_failed');
  process.exitCode=1;
}
