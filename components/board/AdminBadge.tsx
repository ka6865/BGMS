import React from 'react';

export function AdminBadge({ className = "" }: { className?: string }) {
  return (
    <span 
      className={`inline-flex items-center text-[9.5px] font-extrabold text-accent bg-accent/10 border border-[var(--color-accent)]/30 px-1.5 py-0.5 rounded leading-none tracking-wider select-none ${className}`}
      title="BGMS 공식 관리자"
    >
      ADMIN
    </span>
  );
}

export default AdminBadge;
