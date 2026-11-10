'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChatFeedbackReason, ChatMessage } from '@miniapp/shared';
import { useChatFeedbackQuery, useSaveChatFeedbackMutation } from '@/lib/api/chat-feedback';

export function useReplyFeedback(message: ChatMessage) {
  const [open, setOpen] = useState(false);
  const [reasons, setReasons] = useState<ChatFeedbackReason[]>([]);
  const [detail, setDetail] = useState('');
  const [error, setError] = useState('');
  const dirty = useRef(false);
  const locked = useRef(false);
  const target = {
    sessionId: message.session_id,
    messageId: message.id,
    version: message.edit_version ?? 0,
  };
  const query = useChatFeedbackQuery(target, open);
  const mutation = useSaveChatFeedbackMutation(target);
  useEffect(() => {
    // A late read must never replace text the user has already started entering.
    if (!dirty.current && query.data?.feedback) {
      setReasons(query.data.feedback.reasons);
      setDetail(query.data.feedback.detail);
    }
  }, [query.data]);
  const changeOpen = (next: boolean) => {
    if (!locked.current) setOpen(next);
  };
  const toggleReason = (reason: ChatFeedbackReason) => {
    dirty.current = true;
    setReasons((current) =>
      current.includes(reason) ? current.filter((item) => item !== reason) : [...current, reason]
    );
  };
  const changeDetail = (value: string) => {
    dirty.current = true;
    setDetail(value);
  };
  const submit = async () => {
    if (locked.current || detail.length > 500) return;
    locked.current = true;
    dirty.current = true;
    setError('');
    try {
      await mutation.mutateAsync({
        expected_version: target.version,
        reasons,
        detail: detail.trim(),
      });
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '反馈暂未保存，请重试，填写的内容还在');
    } finally {
      locked.current = false;
    }
  };
  return {
    open,
    changeOpen,
    reasons,
    detail,
    changeDetail,
    toggleReason,
    submit,
    error,
    submitted: Boolean(query.data?.feedback),
    pending: mutation.isPending,
  };
}
