export interface UserChatListItem {
  fileName: string;
  characterAvatar: string;
  characterAvatarUrl: string;
  characterName: string;
  characterId: string | null;
  isGroup: boolean;
  lastMessage: string;
  lastMessageAt: string;
  messageCount: number;
  fileSize: number;
}

export interface GetUserChatsData {
  items: UserChatListItem[];
  total: number;
}

export interface GetLatestUserChatData {
  item: UserChatListItem | null;
}
