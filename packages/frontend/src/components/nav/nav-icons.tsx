import type { ReactNode } from 'react';

/** 底栏专用细线图标：统一 24 网格、1.55 线宽、圆角端点，颜色随 currentColor。 */
export type NavIcon = (props: { className?: string }) => ReactNode;

function Line({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.55}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

/** 对话：左下带尾巴的气泡，对应接着聊。 */
export const ChatIcon: NavIcon = ({ className }) => (
  <Line className={className}>
    <path d="M7.6 4h8.8A2.6 2.6 0 0 1 19 6.6v6.8a2.6 2.6 0 0 1-2.6 2.6h-5.2l-3.8 3.4V16A2.4 2.4 0 0 1 5 13.6v-7A2.6 2.6 0 0 1 7.6 4Z" />
    <path d="M9 8.8h6M9 11.8h3.6" />
  </Line>
);

/** 剧场：票根，对应找剧与追剧。 */
export const TicketIcon: NavIcon = ({ className }) => (
  <Line className={className}>
    <path d="M4 7.2A2.2 2.2 0 0 1 6.2 5h11.6A2.2 2.2 0 0 1 20 7.2v2.3a2.5 2.5 0 0 0 0 5v2.3a2.2 2.2 0 0 1-2.2 2.2H6.2A2.2 2.2 0 0 1 4 16.8v-2.3a2.5 2.5 0 0 0 0-5Z" />
    <path d="M14.6 7.6v1.4M14.6 11.3v1.4M14.6 15v1.4" />
  </Line>
);

/** 秘境：主次两颗星芒，中间圆钮专用。 */
export const SparkIcon: NavIcon = ({ className }) => (
  <Line className={className}>
    <path d="M11 3.8l1.75 4.95 4.95 1.75-4.95 1.75L11 17.2l-1.75-4.95L4.3 10.5l4.95-1.75z" />
    <path
      d="M18 14.6l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z"
      fill="currentColor"
      stroke="none"
    />
  </Line>
);

/** 创作：笔尖。 */
export const NibIcon: NavIcon = ({ className }) => (
  <Line className={className}>
    <path d="M12 3.2l5.6 7.3L12 20.8 6.4 10.5z" />
    <path d="M12 12.6v8.2" />
    <circle cx="12" cy="10.4" r="1.25" fill="currentColor" stroke="none" />
  </Line>
);

/** 我的：人像。 */
export const PersonIcon: NavIcon = ({ className }) => (
  <Line className={className}>
    <circle cx="12" cy="8.6" r="3.6" />
    <path d="M5 20.2c1.3-3.7 4-5.6 7-5.6s5.7 1.9 7 5.6" />
  </Line>
);
