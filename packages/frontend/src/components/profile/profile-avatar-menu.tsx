'use client';

import { useRef, useState } from 'react';
import { ImageUp, Link as LinkIcon, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  usePatchUserSettingsMutation,
  useSetUserAvatarMutation,
  useUserSettingsQuery,
} from '@/lib/api/settings';

export function ProfileAvatarMenu({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const settings = useUserSettingsQuery({ enabled: true });
  const patchSettings = usePatchUserSettingsMutation();
  const setAvatar = useSetUserAvatarMutation();

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        throw new Error('仅支持 PNG、JPEG 或 WebP 图片');
      }
      if (file.size > 2 * 1024 * 1024) throw new Error('头像文件不能超过 2MB');
      await setAvatar.mutateAsync({
        source: 'upload',
        content_type: file.type,
        data_base64: await readFileAsBase64(file),
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '头像上传失败');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const importUrl = async () => {
    const url = window.prompt('粘贴 HTTPS 图片链接（PNG、JPEG 或 WebP，最大 2MB）');
    if (!url?.trim()) return;
    setError(null);
    try {
      await setAvatar.mutateAsync({ source: 'url', url: url.trim() });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '头像导入失败');
    }
  };

  const resetAvatar = async () => {
    setError(null);
    try {
      await patchSettings.mutateAsync({ avatar_url: null });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '恢复默认头像失败');
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => void importFile(event.target.files?.[0])}
      />
      <div
        role="menu"
        className="absolute left-0 top-[calc(100%+0.9rem)] z-30 w-max min-w-[220px] max-w-[calc(100vw-2.5rem)] rounded-2xl border border-border bg-popover/95 p-2.5 shadow-[0_18px_60px_rgba(0,0,0,0.55)] ring-1 ring-primary/5 backdrop-blur-xl"
      >
        <span className="absolute -top-1.5 left-6 size-3 rotate-45 border-l border-t border-border bg-popover" />
        <div className="relative flex items-center justify-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            role="menuitem"
            disabled={setAvatar.isPending}
            onClick={() => inputRef.current?.click()}
            className="min-h-11 rounded-full border-border bg-card text-foreground hover:bg-secondary hover:text-foreground"
          >
            <ImageUp aria-hidden />
            上传图片
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            role="menuitem"
            disabled={setAvatar.isPending}
            onClick={() => void importUrl()}
            className="min-h-11 rounded-full border-border bg-card text-foreground hover:bg-secondary hover:text-foreground"
          >
            <LinkIcon aria-hidden />
            导入链接
          </Button>
        </div>
        {settings.data?.settings.avatar_source === 'custom' ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            role="menuitem"
            disabled={patchSettings.isPending}
            onClick={() => void resetAvatar()}
            className="mt-1 min-h-11 w-full rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <RotateCcw aria-hidden />
            恢复跟随 Telegram
          </Button>
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 max-w-[240px] px-2 text-center text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取头像文件失败'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const separator = result.indexOf(',');
      if (separator < 0) {
        reject(new Error('读取头像文件失败'));
        return;
      }
      resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}
