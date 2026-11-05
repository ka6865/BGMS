import{createHash}from'node:crypto';
import{readFile}from'node:fs/promises';
import{expect,it}from'vitest';
import icons from'../lib/lol/data/mayhem-retired-icons.json';
import reviews from'../lib/lol/data/mayhem-augment-review-16.21.json';
import config from'../next.config';
it('삭제된 증강 39개의 원본 이미지와 로컬 파일 해시가 일치한다',async()=>{
 const removed=reviews.reviews.filter(r=>r.status==='removed');expect(icons.images.map(i=>i.externalId).sort()).toEqual(removed.map(r=>r.externalId).sort());
 for(const i of icons.images){expect(i.pageUrl).toBe(removed.find(r=>r.externalId===i.externalId)?.sourceUrl);expect(new URL(i.imageUrl).origin).toBe('https://arammayhem.com');expect(i.hash).toMatch(/^[a-f0-9]{64}$/);const b=await readFile(`public/lol/augment-art/${i.hash}.webp`);expect(b.length).toBe(i.bytes);expect(b.subarray(0,4).toString()).toBe('RIFF');expect(b.subarray(8,12).toString()).toBe('WEBP');expect(createHash('sha256').update(b).digest('hex')).toBe(i.hash);}
 const headers=await config.headers!();expect(headers.find(h=>h.source==='/lol/augment-art/:path*')?.headers).toContainEqual({key:'Cache-Control',value:'public, max-age=31536000, immutable'});
});
