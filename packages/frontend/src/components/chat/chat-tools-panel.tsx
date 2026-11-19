'use client';

import { useEffect, useState, type ComponentType } from 'react';
import { ChevronLeft, MessagesSquare, Mic, BookOpen } from 'lucide-react';
import type { UserPersona } from '@miniapp/shared';
import { StoryGuideTips } from '@/components/onboarding/story-guide-tips';

import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useCharacterMySettingsQuery } from '@/lib/api/character-persona';
import { cn } from '@/lib/utils';
import { ChatCharacterModules, ChatPersonaEditor } from './chat-character-settings';
import { ChatStatusModule } from './chat-status-module';
import { ToolRow } from './chat-tool-row';
import { ChatVoicePicker, ChatVoiceSettings } from './chat-voice-settings';

type ToolsTab = 'chat' | 'voice';
type ToolsPanel = 'voice' | 'guide' | 'persona' | null;

const PANEL_TITLES: Record<Exclude<ToolsPanel, null>, string> = {
  voice: '默认声音',
  guide: '玩法小贴士',
  persona: '人设',
};

const PANEL_DESCRIPTIONS: Record<Exclude<ToolsPanel, null>, string> = {
  voice: '选择角色说话的声音',
  guide: '常见功能怎么用，各个开关是干嘛的',
  persona: '新建或编辑主角人设',
};

const TABS: { key: ToolsTab; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { key: 'chat', label: '对话设置', icon: MessagesSquare },
  { key: 'voice', label: '语音设置', icon: Mic },
];

interface ChatToolsPanelProps {
  characterId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChatToolsPanel({ characterId, open, onOpenChange }: ChatToolsPanelProps) {
  const [tab, setTab] = useState<ToolsTab>('chat');
  const [panel, setPanel] = useState<ToolsPanel>(null);
  // 编辑中的人设；null 表示新建。
  const [editingPersona, setEditingPersona] = useState<UserPersona | null>(null);
  const characterSettings = useCharacterMySettingsQuery(characterId, open);

  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      setPanel(null);
      setTab('chat');
    }, 200);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="chat-scroll-area max-h-[82vh] overflow-y-auto rounded-t-3xl border-border bg-background px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-5"
      >
        {panel === null ? (
          <>
            <SheetTitle className="text-[16px] font-bold text-foreground">工具箱</SheetTitle>
            <SheetDescription className="mt-0.5 text-[12px] text-muted-foreground">
              角色设定、玩法和语音
            </SheetDescription>

            <ToolsTabs tab={tab} onChange={setTab} />

            {tab === 'chat' ? (
              <div className="space-y-2.5">
                {/* 人设与补充设定直接展开在这里，省掉一次点进二级页 */}
                <ChatCharacterModules
                  characterId={characterId}
                  onEditPersona={(persona) => {
                    setEditingPersona(persona);
                    setPanel('persona');
                  }}
                />
                <ChatStatusModule characterId={characterId} />
                <ToolRow
                  icon={BookOpen}
                  title="玩法小贴士"
                  hint="聊偏了怎么办，各个开关是干嘛的"
                  onClick={() => setPanel('guide')}
                />
              </div>
            ) : (
              <ChatVoiceSettings onOpenVoicePicker={() => setPanel('voice')} />
            )}
          </>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPanel(null)}
                aria-label="返回工具箱"
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronLeft className="size-5" aria-hidden />
              </button>
              <SheetTitle className="text-[16px] font-bold text-foreground">
                {panel === 'persona'
                  ? editingPersona
                    ? '编辑人设'
                    : '新建人设'
                  : PANEL_TITLES[panel]}
              </SheetTitle>
            </div>
            <SheetDescription className="sr-only">{PANEL_DESCRIPTIONS[panel]}</SheetDescription>

            {panel === 'voice' ? (
              <ChatVoicePicker onPicked={() => setPanel(null)} />
            ) : panel === 'persona' ? (
              <ChatPersonaEditor
                key={editingPersona?.id ?? 'new'}
                characterId={characterId}
                persona={editingPersona}
                firstPersona={(characterSettings.data?.personas.length ?? 0) === 0}
                onDone={() => setPanel(null)}
              />
            ) : (
              <StoryGuideTips />
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ToolsTabs({ tab, onChange }: { tab: ToolsTab; onChange: (tab: ToolsTab) => void }) {
  return (
    <div className="my-4 flex gap-1 rounded-full bg-muted p-1">
      {TABS.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onChange(item.key)}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-[13px] font-medium transition-colors',
            tab === item.key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
          )}
        >
          <item.icon className="size-3.5" aria-hidden />
          {item.label}
        </button>
      ))}
    </div>
  );
}
