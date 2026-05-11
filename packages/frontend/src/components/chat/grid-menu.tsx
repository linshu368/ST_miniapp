'use client';

import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import { useHaptic } from '@/lib/telegram/hooks';

interface GridMenuProps {
  charName?: string;
}

interface MenuOption {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}

export function GridMenu({ charName }: GridMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  const haptic = useHaptic();

  const handleToggle = useCallback(() => {
    haptic.impact('light');
    setOpen((prev) => !prev);
  }, [haptic]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  const handleSelect = useCallback(
    (option: () => void) => {
      haptic.impact('medium');
      setOpen(false);
      option();
    },
    [haptic]
  );

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const options: MenuOption[] = [
    {
      icon: <SparklesIcon />,
      label: '模型选择',
      onClick: () => {
        console.log('模型选择');
      },
    },
    {
      icon: <TextIcon />,
      label: '回复字数',
      onClick: () => {
        console.log('回复字数');
      },
    },
    {
      icon: <ChatIcon />,
      label: '新建对话',
      onClick: () => {
        if (charName) {
          router.push('/');
        }
      },
    },
  ];

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="菜单"
        aria-expanded={open}
        onClick={handleToggle}
        className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[14px] border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.08)] backdrop-blur-sm transition-all active:scale-95"
      >
        <GridIcon isActive={open} />
      </button>

      {open && (
        <div className="absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2">
          <div className="animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1 duration-150">
            <div className="flex w-max min-w-[160px] flex-col gap-0.5 rounded-[16px] border border-[rgba(255,255,255,0.1)] bg-[rgba(20,21,25,0.98)] p-1.5 shadow-xl shadow-black/30 backdrop-blur-xl">
              {options.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => handleSelect(option.onClick)}
                  className="flex items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left transition-colors hover:bg-[rgba(255,255,255,0.06] active:bg-[rgba(255,255,255,0.03)]"
                >
                  <span className="flex h-[28px] w-[28px] items-center justify-center rounded-[8px] bg-[rgba(255,255,255,0.07]">
                    {option.icon}
                  </span>
                  <span className="text-[13px] text-[rgba(242,243,245,0.88)]">{option.label}</span>
                </button>
              ))}
            </div>
            {charName && (
              <div className="flex items-center justify-end gap-1.5 px-1 pt-1.5">
                <SparkleSmallIcon />
                <span className="text-[10px] text-[rgba(242,243,245,0.3)]">讯事 {charName}</span>
              </div>
            )}
            {/* Arrow pointing down */}
            <div
              className="absolute left-1/2 h-2 w-2 -translate-x-1/2 bg-[rgba(20,21,25,0.98)]"
              style={{ top: '100%', transform: 'translateX(-50%) rotate(45deg)' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function GridIcon({ isActive }: { isActive: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={isActive ? 'rgba(255,220,50,0.9)' : 'none'}
      stroke={isActive ? 'rgba(255,220,50,0.9)' : 'rgba(242,243,245,0.6)'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="rgba(242,243,245,0.7)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v3m6.36-2.36l-2.12 2.12M21 12h-3m2.36 6.36l-2.12-2.12M12 21v-3m-6.36 2.36l2.12-2.12M3 12h3m-2.36-6.36l2.12 2.12" />
    </svg>
  );
}

function TextIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="rgba(242,243,245,0.7)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7V4h16v3" />
      <path d="M9 20h6" />
      <path d="M12 4v16" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="rgba(242,243,245,0.7)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 10h8M8 14h4" />
    </svg>
  );
}

function SparkleSmallIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="rgba(242,243,245,0.4)"
      stroke="none"
      aria-hidden="true"
    >
      <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
    </svg>
  );
}
