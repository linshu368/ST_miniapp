'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteCharacterDraft,
  loadCharacterDraft,
  saveCharacterDraft,
  type CharacterDraftScope,
  type CharacterEditorDraft,
} from './character-editor-draft';

/** The caller keys the editor by owner and draft identity; no draft can hydrate into another form. */
export function useCharacterEditorDraft(scope: CharacterDraftScope, initial: CharacterEditorDraft) {
  const scopeRef = useRef(scope);
  const initialRef = useRef(initial);
  const [value, setValue] = useState(initial);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [conflict, setConflict] = useState(false);
  const latest = useRef(initial);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(false);
  const completed = useRef(false);
  const replacement = useRef<Promise<boolean> | null>(null);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    // A replacement owns the next stored value; blur/pagehide must not queue the old draft after it.
    if (replacement.current) return replacement.current;
    if (completed.current || revision.current === savedRevision.current) return true;
    const pendingRevision = revision.current;
    try {
      await saveCharacterDraft(scopeRef.current, latest.current);
      savedRevision.current = pendingRevision;
      if (mounted.current && revision.current === pendingRevision) setStatus('saved');
      return true;
    } catch {
      if (mounted.current && revision.current === pendingRevision) setStatus('error');
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    loadCharacterDraft(scopeRef.current)
      .then((saved) => {
        if (cancelled) return;
        if (saved) {
          latest.current = saved;
          setValue(saved);
          setStatus('saved');
          if (
            initialRef.current.serverRevision !== null &&
            saved.serverRevision !== initialRef.current.serverRevision
          )
            setConflict(true);
        }
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setReady(true);
          setStatus('error');
        }
      });
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    const onLeave = () => {
      void flush();
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      cancelled = true;
      mounted.current = false;
      void flush();
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [flush]);

  const update = useCallback(
    (change: CharacterEditorDraft | ((current: CharacterEditorDraft) => CharacterEditorDraft)) => {
      if (completed.current) return;
      const next = typeof change === 'function' ? change(latest.current) : change;
      latest.current = next;
      revision.current += 1;
      setValue(next);
      setStatus('saving');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void flush();
      }, 350);
    },
    [flush]
  );

  const replace = useCallback((next: CharacterEditorDraft) => {
    if (replacement.current) return replacement.current;
    clearTimeout(timer.current);
    // Persist the replacement before letting the editor discard its current in-memory text.
    const pending = (async () => {
      try {
        await saveCharacterDraft(scopeRef.current, next);
        latest.current = next;
        revision.current += 1;
        savedRevision.current = revision.current;
        completed.current = false;
        if (mounted.current) {
          setValue(next);
          setStatus('saved');
          setConflict(false);
        }
        return true;
      } catch {
        if (mounted.current) setStatus('error');
        return false;
      }
    })();
    replacement.current = pending;
    void pending.then(() => {
      if (replacement.current === pending) replacement.current = null;
    });
    return pending;
  }, []);

  const clear = useCallback(async () => {
    completed.current = true;
    clearTimeout(timer.current);
    try {
      await deleteCharacterDraft(scopeRef.current);
    } catch {
      /* A published server record remains the source of truth. */
    }
  }, []);

  return { value, update, replace, ready, status, flush, clear, conflict, setConflict };
}
