import React from 'react';
import { AlertCircle, Trash2, Info } from 'lucide-react';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  type?: 'warning' | 'danger' | 'info';
  isPending?: boolean;
}

export default function ConfirmModal({
  isOpen,
  title,
  description,
  confirmText = '확인',
  cancelText = '취소',
  onConfirm,
  onCancel,
  type = 'info',
  isPending = false,
}: ConfirmModalProps) {
  useLockBodyScroll(isOpen);

  if (!isOpen) return null;

  // 타입별 아이콘 및 테마 색상 설정
  const getThemeConfig = () => {
    switch (type) {
      case 'danger':
        return {
          icon: Trash2,
          iconColor: '#ff4b4b',
          iconBg: 'rgba(255, 75, 75, 0.1)',
          confirmBg: '#ff4b4b',
          confirmHoverBg: '#e04141',
          shadow: '0 4px 15px rgba(255, 75, 75, 0.2)',
        };
      case 'warning':
        return {
          icon: AlertCircle,
          iconColor: 'var(--color-accent)',
          iconBg: 'rgba(242, 169, 0, 0.1)',
          confirmBg: 'var(--color-accent)',
          confirmHoverBg: '#d99700',
          shadow: '0 4px 15px rgba(242, 169, 0, 0.2)',
        };
      case 'info':
      default:
        return {
          icon: Info,
          iconColor: '#34A853',
          iconBg: 'rgba(52, 168, 83, 0.1)',
          confirmBg: '#34A853',
          confirmHoverBg: '#2c8f47',
          shadow: '0 4px 15px rgba(52, 168, 83, 0.2)',
        };
    }
  };

  const theme = getThemeConfig();
  const IconComponent = theme.icon;

  return (
    <div 
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.8)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        animation: 'fade-in 0.2s ease',
      }}
    >
      <div 
        style={{
          backgroundColor: 'var(--color-bg-surface)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '24px',
          maxWidth: '400px',
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: '28px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: '20px',
          boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
          animation: 'scale-up 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
      >
        <div style={{
          width: '56px',
          height: '56px',
          borderRadius: '18px',
          backgroundColor: theme.iconBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: theme.iconColor,
          marginBottom: '8px',
        }}>
          <IconComponent size={28} />
        </div>
        
        <div>
          <h3 style={{ fontSize: '18px', fontWeight: 800, color: 'white', margin: '0 0 10px 0', letterSpacing: '-0.3px' }}>
            {title}
          </h3>
          <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.4)', margin: 0, lineHeight: 1.6 }}>
            {description}
          </p>
        </div>
        
        <div style={{ display: 'flex', gap: '12px', width: '100%', marginTop: '10px' }}>
          <button 
            disabled={isPending}
            onClick={onCancel}
            style={{
              flex: 1,
              padding: '14px',
              backgroundColor: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '12px',
              color: 'white',
              fontWeight: 700,
              fontSize: '14px',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {cancelText}
          </button>
          <button 
            disabled={isPending}
            onClick={onConfirm}
            style={{
              flex: 1,
              padding: '14px',
              backgroundColor: theme.confirmBg,
              border: 'none',
              borderRadius: '12px',
              color: type === 'warning' ? 'black' : 'white',
              fontWeight: 800,
              fontSize: '14px',
              cursor: isPending ? 'wait' : 'pointer',
              transition: 'all 0.2s',
              boxShadow: theme.shadow,
            }}
          >
            {isPending ? '처리 중...' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
