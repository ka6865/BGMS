import type { DiscoveryJob } from './matchDiscovery';
import type { BasicMatchIngestOutcome } from './playerMatchesIngest';

type Settlement = { state: 'saved' | 'retry' | 'unavailable'; nextAttemptAt?: string; errorCode?: string };
export type DiscoveryWorkerDependencies = {
  claim: (limit: number) => Promise<DiscoveryJob[]>;
  settle: (job: DiscoveryJob, outcome: Settlement) => Promise<void>;
  ingest: (job: DiscoveryJob) => Promise<BasicMatchIngestOutcome>;
  alreadyStored?: (job: DiscoveryJob) => Promise<boolean>;
  now?: () => number; limit?: number; maxDurationMs?: number;
};
export async function runDiscoveryWorker(d: DiscoveryWorkerDependencies) {
  const now=d.now ?? Date.now;
  const started=now();
  const limit=Math.max(0,Math.min(300,d.limit ?? 300));
  const summary={claimed:0,saved:0,retry:0,unavailable:0,rateLimited:false,durationMs:0};
  while(summary.claimed<limit && now()-started<(d.maxDurationMs ?? 480000)) {
    const jobs=await d.claim(Math.min(3,limit-summary.claimed));
    if(!jobs.length) break;
    summary.claimed+=jobs.length;
    const results=await Promise.allSettled(jobs.map(async job=>{
      if (await d.alreadyStored?.(job)) {
        await d.settle(job,{state:'saved'});
        summary.saved+=1;
        return;
      }
      let result: BasicMatchIngestOutcome;
      try { result=await d.ingest(job); }
      catch { result={status:'network_error',record:null,httpStatus:null,rateLimitHeaders:null}; }
      let outcome: Settlement;
      if(result.status==='saved') outcome={state:'saved'};
      else if(result.status==='not_found' && job.not_found_count>=1) outcome={state:'unavailable',errorCode:'not_found'};
      else {
        let delay=result.status==='not_found' ? 21600000 : [60000,300000,1800000,21600000][Math.min(Math.max(job.attempts-1,0),3)];
        if(result.status==='rate_limited') {
          summary.rateLimited=true;
          const reset=Date.parse(result.rateLimitHeaders?.resetAt ?? '');
          delay=Math.max(60000,result.rateLimitHeaders?.retryAfterMs ?? 0,Number.isFinite(reset) ? reset-now() : 0);
        }
        outcome={state:'retry',nextAttemptAt:new Date(now()+delay).toISOString(),errorCode:result.status};
      }
      await d.settle(job,outcome);
      summary[outcome.state]+=1;
    }));
    const failure=results.find((r):r is PromiseRejectedResult=>r.status==='rejected');
    if(failure) throw failure.reason;
    if(summary.rateLimited) break;
  }
  summary.durationMs=now()-started;
  return summary;
}
