'use client';

import dynamic from 'next/dynamic';
import { Suspense, useState } from 'react';
import { InlineIconLabel } from '@/components/common/InlineIconLabel';
import type { BgmsIconName } from '@/components/common/BgmsIcon';

const MapSettingsEditor = dynamic(
  () => import('@/components/admin/MapSettingsEditor'),
  { ssr: false }
);
const CategoryMasterEditor = dynamic(
  () => import('@/components/admin/CategoryMasterEditor'),
  { ssr: false }
);

const TABS = [
  { id: 'map', label: '맵별 카테고리 설정', icon: 'map' },
  { id: 'category', label: '카테고리 마스터 관리', icon: 'file' },
] satisfies Array<{ id: 'map' | 'category'; label: string; icon: BgmsIconName }>;

export default function AdminMapSettingsPage() {
  const [activeTab, setActiveTab] = useState<'map' | 'category'>('map');

  return (
    <div className="min-h-full bg-[#0b0f19] text-gray-200">
      <div className="border-b border-[#333] px-3 pt-4 sm:px-8 sm:pt-6">
        <h1 className="text-lg font-black text-white sm:text-xl">맵 설정</h1>
        <p className="mt-1 text-xs text-gray-500">맵별 카테고리 노출과 카테고리 마스터 정보를 관리합니다.</p>
        {/* 탭 헤더: 좁은 화면에서는 줄바꿈 대신 가로 스크롤 */}
        <div role="tablist" aria-label="맵 설정 화면" className="mt-3 flex items-end gap-1 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id as 'map' | 'category')}
              className={`min-h-11 shrink-0 whitespace-nowrap rounded-t-lg px-4 py-2 text-xs font-black transition-colors sm:text-sm ${
                activeTab === tab.id
                  ? 'bg-[#1a1a1a] text-[#F2A900] border border-b-0 border-[#333]'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <InlineIconLabel icon={tab.icon}>{tab.label}</InlineIconLabel>
            </button>
          ))}
        </div>
      </div>

      {/* 탭 콘텐츠 */}
      <div className="px-3 py-4 sm:px-8 sm:py-6">
        <Suspense fallback={
          <div role="status" className="flex min-h-[40vh] items-center justify-center text-sm font-bold text-[#F2A900]">
            불러오는 중...
          </div>
        }>
          {activeTab === 'map' && <MapSettingsEditor />}
          {activeTab === 'category' && <CategoryMasterEditor />}
        </Suspense>
      </div>
    </div>
  );
}
