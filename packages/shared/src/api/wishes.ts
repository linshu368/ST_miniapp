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

export interface GetWishRoleStatusData {
  can_submit: boolean;
  latest_wish: WishRoleData | null;
  next_available_at: string | null;
}

export interface CompleteWishRoleRequest {
  extra_text?: string;
}

export interface CompleteWishRoleData {
  wish: WishRoleData;
}
