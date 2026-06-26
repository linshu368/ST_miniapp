export interface WishRoleData {
  id: string;
  wish_text: string;
  extra_text: string | null;
  reward_credits: number;
  status: 'awaiting_extra' | 'completed';
  created_at: string;
  closed_at: string | null;
}

export interface CreateWishRoleRequest {
  wish_text: string;
}

export interface CreateWishRoleData {
  wish: WishRoleData;
}

export interface CompleteWishRoleRequest {
  extra_text?: string;
}

export interface CompleteWishRoleData {
  wish: WishRoleData;
}
