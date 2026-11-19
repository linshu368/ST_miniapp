'use client';

import type { RefObject } from 'react';
import { IMAGE_PLAZA_PROMPT_MAX_CHARS, VIDEO_PLAZA_PROMPT_MAX_CHARS } from '@miniapp/shared';

export function StudioPromptInput({
  media,
  value,
  inputRef,
  onChange,
  onSubmit,
}: {
  media: 'image' | 'video';
  value: string;
  inputRef: RefObject<HTMLTextAreaElement>;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const limit = media === 'video' ? VIDEO_PLAZA_PROMPT_MAX_CHARS : IMAGE_PLAZA_PROMPT_MAX_CHARS;
  return (
    <textarea
      ref={inputRef}
      value={value}
      maxLength={limit}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' &&
          (event.ctrlKey || event.metaKey) &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          onSubmit();
        }
      }}
      rows={4}
      placeholder={media === 'video' ? '描述你想生成的视频…' : '描述你想生成的画面…'}
      className="min-h-24 w-full resize-none overflow-y-auto bg-transparent text-base leading-7 outline-none placeholder:text-muted-foreground"
    />
  );
}
