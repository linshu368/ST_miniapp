// 🟡 后端替代状态：未被取代。
//    mockCurrentUser / mockWallet 对应的后端接口（/api/users/me、/api/wallet/balance 等）
//    尚未实现。余额当前由 payment mock（订单完成加钱）+ 本文件订阅机制维持。
//    要切换：后端实现用户信息 + 钱包接口后，新建 lib/api/users.ts 并加入 mock-registry。
//
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

// ==== 可订阅的 mock 钱包 ====
// profile 读 / chat 扣费 / recharge 加分 共用同一枚余额；让 mock 体验能贯穿三页。
// 真实接口接入后，这块整体被 /api/users/me + /api/wallet/balance 类 query 取代。

type WalletListener = () => void;
const walletListeners = new Set<WalletListener>();
const walletState = { credits: mockCurrentUser.credits };

export const mockWallet = {
  getCredits(): number {
    return walletState.credits;
  },
  /** 足额则扣除并返回 true；不足返回 false 不改动余额 */
  deduct(amount: number): boolean {
    if (walletState.credits < amount) return false;
    walletState.credits -= amount;
    walletListeners.forEach((l) => l());
    return true;
  },
  add(amount: number): void {
    walletState.credits += amount;
    walletListeners.forEach((l) => l());
  },
  subscribe(listener: WalletListener): () => void {
    walletListeners.add(listener);
    return () => {
      walletListeners.delete(listener);
    };
  },
};
