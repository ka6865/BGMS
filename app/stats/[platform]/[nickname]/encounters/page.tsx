import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import EncountersClient from './EncountersClient';
export const metadata:Metadata={title:'만난 상대 | BGMS',robots:{index:false,follow:false}};
export default async function Page({params,searchParams}:{params:Promise<{platform:string;nickname:string}>;searchParams:Promise<{matchId?:string}>}){
  const {platform,nickname}=await params;const query=await searchParams;
  if(platform!=='steam'&&platform!=='kakao')notFound();
  return <EncountersClient platform={platform} nickname={nickname} matchId={query.matchId}/>;
}
