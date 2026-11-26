'use client';

import { useParams } from 'next/navigation';
import { useChatPage } from '@/hooks/use-chat-page';
import { ChatPageContent } from '@/components/chat/chat-page-content';

function ChatPage({ characterId }: { characterId: string }) {
  const model = useChatPage(characterId);
  return <ChatPageContent model={model} />;
}

export default function SelfHostedChatPage() {
  const { characterId } = useParams<{ characterId: string }>();
  return <ChatPage key={characterId} characterId={characterId} />;
}
