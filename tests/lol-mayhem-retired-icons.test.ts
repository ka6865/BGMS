import{createHash}from'node:crypto';
import{readFile}from'node:fs/promises';
import{expect,it}from'vitest';
import icons from'../lib/lol/data/mayhem-retired-icons.json';
import reviews from'../lib/lol/data/mayhem-augment-review-16.21.json';
import config from'../next.config';
import{archivePage,type MayhemArchive}from'../lib/lol/mayhemArchive';
it('삭제된 증강의 원본 이미지와 로컬 파일 해시가 일치한다',async()=>{
 // 16.21 검토의 삭제 39개와 이후 패치(16.22)에서 삭제된 4개를 보존한다.
 const removed=reviews.reviews.filter(r=>r.status==='removed'),ids=icons.images.map(i=>i.externalId);expect(ids.length).toBe(43);expect(new Set(ids).size).toBe(ids.length);for(const r of removed)expect(ids).toContain(r.externalId);
 for(const i of icons.images){const review=removed.find(r=>r.externalId===i.externalId);if(review)expect(i.pageUrl).toBe(review.sourceUrl);expect(new URL(i.pageUrl).origin).toBe('https://arammayhem.com');expect(new URL(i.imageUrl).origin).toBe('https://arammayhem.com');expect(i.hash).toMatch(/^[a-f0-9]{64}$/);const b=await readFile(`public/lol/augment-art/${i.hash}.webp`);expect(b.length).toBe(i.bytes);expect(b.subarray(0,4).toString()).toBe('RIFF');expect(b.subarray(8,12).toString()).toBe('WEBP');expect(createHash('sha256').update(b).digest('hex')).toBe(i.hash);}
 const headers=await config.headers!();expect(headers.find(h=>h.source==='/lol/augment-art/:path*')?.headers).toContainEqual({key:'Cache-Control',value:'public, max-age=31536000, immutable'});
});
it('삭제 증강은 이후 패치 기록에서도 외부 ID로 보존 그림을 붙이고 공식 증강에는 붙이지 않는다',()=>{
 const i=icons.images[0],url=`/lol/augment-art/${i.hash}.webp`;
 const archive:MayhemArchive={schemaVersion:1,patch:'16.22',augments:[{key:`external:${i.externalId}`,officialId:null,externalIds:[i.externalId],name:i.name,nameEn:null,sourceName:null,rarity:null,status:'removed',removedPatch:'26.20',reason:'',text:'',sourceUrl:null},{key:'official:1',officialId:1,externalIds:[],name:'A',nameEn:null,sourceName:null,rarity:'gold',status:'active',removedPatch:null,reason:'',text:'',sourceUrl:null}],combos:[{id:1,championId:63,augments:[`external:${i.externalId}`,'official:1'],status:'removed',types:[],sourceUrl:'https://arammayhem.com/combo/x/'}]};
 const augments=archivePage(archive,{kind:'augments',status:'all',query:'',championId:null,offset:0},'now');
 expect(augments.kind==='augments'&&augments.rows.map(r=>r.art)).toEqual([url,null]);
 const combos=archivePage(archive,{kind:'combos',status:'all',query:'',championId:null,offset:0},'now');
 expect(combos.kind==='combos'&&combos.rows[0].augments.map(a=>a.art)).toEqual([url,null]);
});
