export async function getCommunityMemberStatus(
  token: string,
  chatId: string,
  userId: string
): Promise<string> {
  const url = new URL(`https://api.telegram.org/bot${token}/getChatMember`);
  url.searchParams.set('chat_id', chatId);
  url.searchParams.set('user_id', userId);
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  const payload = (await response.json()) as {
    ok?: boolean;
    description?: string;
    result?: { status?: string };
  };
  if (!response.ok || !payload.ok || !payload.result?.status) {
    throw new Error(payload.description ?? `Telegram getChatMember failed (${response.status})`);
  }
  return payload.result.status;
}

export function isActiveCommunityMember(status: string): boolean {
  return status === 'member' || status === 'administrator' || status === 'creator';
}
