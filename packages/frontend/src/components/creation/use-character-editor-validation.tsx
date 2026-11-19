'use client';

import type { EditorState } from './use-character-editor-state';
export function useEditorValidation(model: EditorState) {
  const { visibility, cover, missingFields, busy, correctionField, setCorrectionField } = model;
  function focusMissing(label: string) {
    const ids: Record<string, string> = {
      角色形象: 'creator-cover',
      名称: 'creator-name',
      描述: 'creator-description',
      开场白: 'creator-opening',
      背景: 'creator-background',
      标签: 'creator-tags',
      可见性: 'creator-visibility',
    };
    const element = document.getElementById(ids[label] ?? '');
    if (!element) return;
    setCorrectionField(label);
    element.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center',
    });
    const focusTarget =
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element
        : element.parentElement?.querySelector<HTMLElement>(
            label === '可见性' ? 'input:checked' : 'button, input'
          );
    focusTarget?.focus({ preventScroll: true });
  }

  function correctionHint(label: string) {
    if (label !== correctionField) return null;
    const index = missingFields.indexOf(label);
    const next = missingFields.length ? missingFields[(index + 1) % missingFields.length] : null;
    return (
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 text-xs">
        <span className="text-muted-foreground" role="status">
          {missingFields.length ? `还差 ${missingFields.length} 项必填` : '必填项已补齐'}
        </span>
        {next !== label && (
          <button
            type="button"
            disabled={busy}
            className="min-h-11 text-primary"
            onClick={() => focusMissing(next ?? '可见性')}
          >
            {next ? `去补${next}` : '确认可见性'}
          </button>
        )}
      </div>
    );
  }

  return { focusMissing, correctionHint };
}
