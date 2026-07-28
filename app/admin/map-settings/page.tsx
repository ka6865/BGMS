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
    <main className="min-h-screen bg-[#0b0f19]">
      {/* 탭 헤더 */}
      <div className="flex items-end gap-1 px-8 pt-6 border-b border-[#333] bg-[#0b0f19]">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as 'map' | 'category')}
            className={`px-5 py-3 rounded-t-xl font-black text-sm transition-all ${
              activeTab === tab.id
                ? 'bg-[#1a1a1a] text-[#F2A900] border border-b-0 border-[#333]'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <InlineIconLabel icon={tab.icon}>{tab.label}</InlineIconLabel>
          </button>
        ))}
      </div>

      {/* 탭 콘텐츠 */}
      <div className="p-8 text-gray-200">
        <Suspense fallback={
          <div className="min-h-[60vh] flex items-center justify-center text-[#F2A900] font-bold">
            로딩 중...
          </div>
        }>
          {activeTab === 'map' && <MapSettingsEditor />}
          {activeTab === 'category' && <CategoryMasterEditor />}
        </Suspense>
      </div>
    </main>
  );
}
