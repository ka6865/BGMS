import {notFound} from 'next/navigation';
import MatchPageClient from './MatchPageClient';
export const metadata={title:'경기 기록 | BGMS',robots:{index:false,follow:false}};
export default async function Page({params}:{params:Promise<{platform:string;nickname:string;matchId:string}>}){
 const {platform,nickname,matchId}=await params;
 if((platform!=='steam'&&platform!=='kakao')||!/^[A-Za-z0-9_.-]{1,128}$/.test(matchId))notFound();
 return <MatchPageClient key={`${platform}:${nickname}:${matchId}`} platform={platform} nickname={nickname} matchId={matchId}/>;
}
