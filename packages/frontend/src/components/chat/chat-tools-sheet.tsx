'use client';

import { useEffect, useState, type ComponentType } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  Loader2,
  MessagesSquare,
  Mic,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
} from 'lucide-react';

import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useModelCatalogQuery } from '@/lib/api/models';
import { ChatGenerationSettings } from './chat-generation-settings';
import { ChatModelSwitcher } from './chat-model-switcher';

type ToolsTab = 'chat' | 'voice' | 'image';
/** null = 停在一级页；非空时整个抽屉换成对应的二级页，带返回 */
type ToolsPanel = 'model' | 'generation' | null;

const TABS: { key: ToolsTab; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { key: 'chat', label: '对话设置', icon: MessagesSquare },
  { key: 'voice', label: '语音设置', icon: Mic },
  { key: 'image', label: '图片设置', icon: ImageIcon },
];

interface ChatToolsSheetProps {
  /** 充值页返回时要回到的地址，带上当前会话 */
  returnTo: string;
  onCreateConversation: () => void;
  creating: boolean;
}

/**
 * 输入框左侧的工具箱。按钮和抽屉放在同一个组件里：开合状态没有第二个使用者，
 * 抽屉自己走 portal，挂在输入框的左槽里不会被胶囊的圆角裁掉。
 */
export function ChatToolsSheet({ returnTo, onCreateConversation, creating }: ChatToolsSheetProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ToolsTab>('chat');
  const [panel, setPanel] = useState<ToolsPanel>(null);
  const { data: catalog } = useModelCatalogQuery();

  // 关上再打开应当回到一级页，否则下次进来会直接落在上次翻到的二级页里
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      setPanel(null);
      setTab('chat');
    }, 200);
    return () => window.clearTimeout(timer);
  }, [open]);

  const selectedModelName = catalog?.catalog.tiers
    .flatMap((tier) => tier.models)
    .find((model) => model.id === catalog.selected_model_id)?.display_name;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="工具箱"
        className="flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground active:scale-95"
      >
        <WandSparkles className="size-5" aria-hidden />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="chat-scroll-area max-h-[82vh] overflow-y-auto rounded-t-3xl border-border bg-background px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-5"
        >
          {panel === null ? (
            <>
              <SheetTitle className="text-[16px] font-bold text-foreground">工具箱</SheetTitle>
              <SheetDescription className="mt-0.5 text-[12px] text-muted-foreground">
                模型与生成偏好对你的所有角色生效
              </SheetDescription>

              <div className="my-4 flex gap-1 rounded-full bg-muted p-1">
                {TABS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setTab(item.key)}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-[13px] font-medium transition-colors',
                      tab === item.key
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground'
                    )}
                  >
                    <item.icon className="size-3.5" aria-hidden />
                    {item.label}
                  </button>
                ))}
              </div>

              {tab === 'chat' ? (
                <div className="space-y-2">
                  <ToolRow
                    icon={Sparkles}
                    title="模型选择"
                    hint={selectedModelName ?? '选择驱动这段对话的模型'}
                    onClick={() => setPanel('model')}
                  />
                  <ToolRow
                    icon={MessagesSquare}
                    title="开启新对话"
                    hint="保留当前这段，另起一段从头开始"
                    pending={creating}
                    onClick={() => {
                      setOpen(false);
                      onCreateConversation();
                    }}
                  />
                  <ToolRow
                    icon={SlidersHorizontal}
                    title="生成偏好"
                    hint="回复长度、结尾选项、自定义指令"
                    onClick={() => setPanel('generation')}
                  />
                </div>
              ) : (
                <ComingSoon label={tab === 'voice' ? '语音设置' : '图片设置'} />
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
                  {panel === 'model' ? '模型选择' : '生成偏好'}
                </SheetTitle>
              </div>
              <SheetDescription className="sr-only">
                {panel === 'model' ? '选择驱动对话的模型' : '调整回复长度与自定义指令'}
              </SheetDescription>

              {panel === 'model' ? (
                <ChatModelSwitcher returnTo={returnTo} onSwitched={() => setOpen(false)} />
              ) : (
                <ChatGenerationSettings />
              )}
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function ToolRow({
  icon: Icon,
  title,
  hint,
  onClick,
  pending,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  onClick: () => void;
  pending?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 text-left transition-colors hover:bg-secondary disabled:opacity-55"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-[11px] leading-snug text-muted-foreground">
          {hint}
        </span>
      </span>
      {pending ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" aria-hidden />
      )}
    </button>
  );
}

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/50 px-4 py-10 text-center">
      <p className="text-[13px] font-semibold text-foreground">{label}即将开放</p>
      <p className="mt-1 text-[11px] text-muted-foreground">这一栏还在做，先占个位置</p>
    </div>
  );
}
