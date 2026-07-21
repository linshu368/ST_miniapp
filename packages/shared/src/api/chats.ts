export interface UserChatListItem {
  fileName: string;
  characterAvatar: string;
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
