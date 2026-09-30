'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { replaceUserPlaceholder } from '@miniapp/shared';

import { BASE_CSS } from './base-css';
import { composeAppliedView, renderOriginalBody } from './compose';
import type { ReplyRendererProps } from './types';
import type { WorkerOutcome } from './worker-protocol';
import { retainReplyWorker, runReplyPostprocess } from './worker-scheduler';

type Phase =
  | { signature: string; kind: 'pending' }
  | { signature: string; kind: 'original'; reason: string }
  | { signature: string; kind: 'ready'; outcome: WorkerOutcome };

export function ReplyRenderer(props: ReplyRendererProps) {
  const autoKey = useId();
  const scopeKey = props.messageKey ?? autoKey;
  const artifactKey = artifactSignature(props.artifact);
  const signature = `${scopeKey}\0${props.content}\0${artifactKey}`;
  const [phase, setPhase] = useState<Phase>({ signature, kind: 'pending' });
  const openStore = useRef(new Map<string, boolean>());

  if (phase.signature !== signature) {
    setPhase({ signature, kind: 'pending' });
  }

  useEffect(() => {
    let active = true;
    const release = retainReplyWorker();
    if (props.artifact == null) {
      setPhase({ signature, kind: 'original', reason: 'NO_ARTIFACT' });
      return () => {
        active = false;
        release();
      };
    }
    const job = runReplyPostprocess({
      content: props.content,
      artifact: props.artifact,
      messageKey: scopeKey,
    });
    void job.promise.then((outcome) => {
      if (!active) return;
      setPhase({ signature, kind: 'ready', outcome });
    });
    return () => {
      active = false;
      job.cancel();
      release();
    };
  }, [artifactKey, props.artifact, props.content, scopeKey, signature]);

  const live = phase.signature === signature ? phase : { signature, kind: 'pending' as const };
  const plain = replaceUserPlaceholder(props.content, props.displayName);
  if (live.kind === 'pending') {
    return shell(props, 'pending', undefined, plain);
  }
  if (live.kind === 'original') {
    return shell(
      props,
      'original',
      live.reason,
      <>
        <style>{BASE_CSS}</style>
        {renderOriginalBody(props.content, props.displayName)}
      </>
    );
  }
  if (live.outcome.result.status !== 'applied') {
    return shell(
      props,
      'original',
      live.outcome.result.reason,
      <>
        <style>{BASE_CSS}</style>
        {renderOriginalBody(props.content, props.displayName)}
      </>
    );
  }
  const view = composeAppliedView({
    content: props.content,
    displayName: props.displayName,
    segments: live.outcome.result.segments,
    css: live.outcome.css,
    messageKey: scopeKey,
    interactive: props.streaming !== true && props.choiceDisabled !== true,
    onChoice: props.onChoice,
    openStore: openStore.current,
  });
  if (!view.ok) {
    return shell(
      props,
      'original',
      view.reason,
      <>
        <style>{BASE_CSS}</style>
        {renderOriginalBody(props.content, props.displayName)}
      </>
    );
  }
  return shell(props, 'applied', undefined, view.body);
}

function shell(
  props: ReplyRendererProps,
  state: 'pending' | 'original' | 'applied',
  reason: string | undefined,
  children: ReactNode
) {
  const className = ['reply-markdown', props.className].filter(Boolean).join(' ');
  return (
    <div
      className={className}
      data-reply-state={state}
      data-fallback-reason={reason}
      data-theme={props.theme}
      style={props.theme ? { colorScheme: props.theme } : undefined}
    >
      {children}
    </div>
  );
}

function artifactSignature(artifact: unknown): string {
  if (artifact == null) return '';
  try {
    return JSON.stringify(artifact);
  } catch {
    return 'unserializable';
  }
}
