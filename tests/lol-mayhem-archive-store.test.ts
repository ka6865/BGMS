import {createHash} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({publication:vi.fn(),db:vi.fn(),download:vi.fn(),single:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('next/cache',()=>({unstable_cache:(fn:unknown)=>fn}));
vi.mock('@/lib/server/serviceRoleSupabase.server',()=>({createServiceRoleSupabase:mock.db}));
vi.mock('../lib/lol/mayhemDatasetStore.server',()=>({getMayhemDatasetPublication:mock.publication}));
import {getPublicMayhemArchive} from '../lib/lol/mayhemArchive.server';
const archive={schemaVersion:1,patch:'16.21',augments:[],combos:[]};
const body=JSON.stringify(archive);
const row=()=>({verified_client_patch:'16.21',manifest_path:`external/arammayhem/batches/${'a'.repeat(64)}/captures/${'b'.repeat(64)}/normalized/16.21/v2-m1.json`,metadata:{normalizerVersion:2,mappingRevision:1,archiveBytes:Buffer.byteLength(body),archiveHash:createHash('sha256').update(body).digest('hex')}});
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('LOL_PERSISTENCE_ENABLED','true');mock.publication.mockResolvedValue({release_id:6,published_at:'now'});mock.single.mockResolvedValue({data:row(),error:null});mock.download.mockResolvedValue({data:new Blob([JSON.stringify({archive})]),error:null});const q={select:()=>q,eq:()=>q,abortSignal:()=>q,single:mock.single};mock.db.mockReturnValue({from:()=>q,storage:{from:()=>({download:mock.download})}});});
describe('게시된 보존 원본의 무결성',()=>{
 it('게시 포인터가 없으면 후보 파일을 읽지 않는다',async()=>{mock.publication.mockResolvedValue(null);expect(await getPublicMayhemArchive('16.21')).toBeNull();expect(mock.db).not.toHaveBeenCalled();});
 it('게시된 승인본을 검증하고 읽는다',async()=>{expect(await getPublicMayhemArchive('16.21')).toEqual({archive,publishedAt:'now'});});
 it.each(['hash','bytes','patch','path','version'])('손상된 %s를 거부한다',async kind=>{const r=row();if(kind==='hash')r.metadata.archiveHash='0'.repeat(64);if(kind==='bytes')r.metadata.archiveBytes++;if(kind==='patch')r.verified_client_patch='16.22';if(kind==='path')r.manifest_path='other/private.json';if(kind==='version')r.metadata.normalizerVersion=1;mock.single.mockResolvedValue({data:r,error:null});await expect(getPublicMayhemArchive('16.21')).rejects.toThrow(/mayhem_archive/);});
 it('파일 다운로드 실패를 빈 자료로 위장하지 않는다',async()=>{mock.download.mockResolvedValue({data:null,error:{message:'fail'}});await expect(getPublicMayhemArchive('16.21')).rejects.toThrow('mayhem_archive_unavailable');});
});
