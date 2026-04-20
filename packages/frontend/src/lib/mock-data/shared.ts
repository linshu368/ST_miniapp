// 跨模块共享的 mock 类型/数据（多 PM 协调入口，改动需双方确认）
// 规则：任何同时被多个业务模块（characters / chat / ...）引用的类型或常量都放这里。

export interface MockUser {
  id: string;
  tg_id: number;
  username: string;
  avatar_url: string;
  credits: number;
}

export const mockCurrentUser: MockUser = {
  id: 'user-001',
  tg_id: 100000001,
  username: 'demo_user',
  avatar_url: '',
  credits: 100,
};
