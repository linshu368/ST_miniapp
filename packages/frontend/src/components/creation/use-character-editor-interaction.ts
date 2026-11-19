'use client';

import { type CharacterDraft } from '@miniapp/shared';
import { useRef, useState } from 'react';
import {
  type CharacterPolishSession,
  type CharacterPolishTarget,
} from './character-editor-dialogs';

import { type TextField } from './character-editor-fields';
export function useEditorInteraction(draft: CharacterDraft) {
  const [editing, setEditing] = useState<TextField | null>(null);
  const [fullCover, setFullCover] = useState(false);
  const [correctionField, setCorrectionField] = useState('');
  const showRequired = Boolean(correctionField);
  const [coverError, setCoverError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryDraftId, setRecoveryDraftId] = useState<string | null>(null);
  const backupId = useRef<string | null>(null);
  const [importNotice, setImportNotice] = useState({ background: '', preset: '' });
  const [session, setSession] = useState<CharacterPolishSession | null>(null);
  const sessionRef = useRef<CharacterPolishSession | null>(null);
  const [polishOpen, setPolishOpen] = useState(false);
  const [polishFeedback, setPolishFeedback] = useState<
    Partial<Record<CharacterPolishTarget, string>>
  >({});
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useRef<AbortController | null>(null);
  const polishSnapshot = useRef(draft);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const adoptedCover = useRef<string | null>(null);
  return {
    editing,
    setEditing,
    fullCover,
    setFullCover,
    correctionField,
    setCorrectionField,
    showRequired,
    coverError,
    setCoverError,
    notice,
    setNotice,
    working,
    setWorking,
    recoveryOpen,
    setRecoveryOpen,
    recoveryDraftId,
    setRecoveryDraftId,
    backupId,
    importNotice,
    setImportNotice,
    session,
    setSession,
    sessionRef,
    polishOpen,
    setPolishOpen,
    polishFeedback,
    setPolishFeedback,
    fileInput,
    active,
    polishSnapshot,
    busyRef,
    mounted,
    adoptedCover,
  };
}
