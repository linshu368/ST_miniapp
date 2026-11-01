'use client';

import { useRef, useState } from 'react';
import { FileText, Upload, X } from 'lucide-react';
import type { CharacterSourceFile } from '@miniapp/shared';
import { CharacterEditorModal } from './character-editor-dialogs';
import {
  MAX_CREATOR_DOCUMENTS,
  documentLength,
  readCreatorDocument,
} from './character-editor-import';

export function CreatorDocumentImport({
  label,
  files,
  disabled,
  onImport,
  onMessage,
}: {
  label: string;
  files: CharacterSourceFile[];
  disabled?: boolean;
  onImport: (text: string, files: CharacterSourceFile[]) => void;
  onMessage: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const reading = useRef(false);
  const [busy, setBusy] = useState(false);
  async function importFiles(selection: File[]) {
    if (!selection.length || reading.current) return;
    if (selection.length > MAX_CREATOR_DOCUMENTS) {
      onMessage('每次最多导入 10 个文件。');
      return;
    }
    reading.current = true;
    setBusy(true);
    onMessage('');
    const text: string[] = [];
    const added: CharacterSourceFile[] = [];
    const errors: string[] = [];
    try {
      for (const file of selection) {
        try {
          const parsed = await readCreatorDocument(file);
          if (
            [...files, ...added].some(
              (item) => item.name === file.name && item.content === parsed.content
            )
          )
            continue;
          if (parsed.inline) text.push(parsed.content);
          else if (files.length + added.length >= MAX_CREATOR_DOCUMENTS) {
            errors.push('每项最多保留 10 个文件，请先移除不需要的文件。');
            break;
          } else added.push({ id: crypto.randomUUID(), name: file.name, content: parsed.content });
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `${file.name} 读取失败。`);
        }
      }
      onImport(text.join('\n\n'), added);
      onMessage(
        errors.length
          ? errors.join(' ')
          : text.length
            ? '短文件内容已填入输入框。'
            : added.length
              ? '文件已加入，AI 润色会参考完整内容。'
              : '这些文件已经导入。'
      );
    } finally {
      reading.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        disabled={busy || disabled}
        onClick={() => input.current?.click()}
        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[11px] text-primary disabled:opacity-40"
        aria-label={`导入${label}TXT或JSON文件`}
      >
        <Upload className="size-3.5" aria-hidden />
        {busy ? '读取中…' : '导入 TXT / JSON'}
      </button>
      <input
        ref={input}
        className="hidden"
        type="file"
        accept=".txt,.json,text/plain,application/json"
        multiple
        tabIndex={-1}
        aria-label={`${label}文件`}
        onChange={(event) => {
          const selection = Array.from(event.target.files || []);
          event.target.value = '';
          void importFiles(selection);
        }}
      />
    </>
  );
}

export function CreatorDocumentAttachments({
  files,
  disabled,
  onRemove,
}: {
  files: CharacterSourceFile[];
  disabled?: boolean;
  onRemove: (id: string) => void;
}) {
  const [selected, setSelected] = useState<CharacterSourceFile | null>(null);
  return (
    <>
      {files.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>参考文件</span>
            <span>{files.length} / 10</span>
          </div>
          {files.map((file) => (
            <div
              className="flex items-center rounded-xl border border-input bg-card pr-1"
              key={file.id}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2.5 p-3 text-left"
                onClick={() => setSelected(file)}
                aria-label={`查看文件 ${file.name}`}
              >
                <FileText className="size-5 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-foreground">{file.name}</span>
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    {documentLength(file.content).toLocaleString()} 字 · 点击查看
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="grid size-11 shrink-0 place-items-center text-muted-foreground disabled:opacity-40"
                disabled={disabled}
                onClick={() => onRemove(file.id)}
                aria-label={`移除文件 ${file.name}`}
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      {selected && (
        <CharacterEditorModal title={selected.name} onClose={() => setSelected(null)}>
          <pre className="min-h-0 flex-1 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words px-5 py-6 font-sans text-sm leading-8 text-foreground">
            {selected.content}
          </pre>
        </CharacterEditorModal>
      )}
    </>
  );
}
