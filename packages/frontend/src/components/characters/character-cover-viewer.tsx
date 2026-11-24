'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X, ZoomIn, ZoomOut } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  useCoverGestures,
  useCoverResize,
  type CoverPoint as Point,
  type CoverView as View,
} from './character-cover-gestures';

const origin: View = { x: 0, y: 0, scale: 1 };
const control =
  'absolute grid size-11 place-items-center rounded-full bg-black/55 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white';

interface CharacterCoverViewerProps {
  src: string;
  name: string;
  onClose: () => void;
  returnFocus: () => void;
}

export function CharacterCoverViewer({
  src,
  name,
  onClose,
  returnFocus,
}: CharacterCoverViewerProps) {
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [view, setView] = useState(origin);
  const current = useRef(origin);
  const [failed, setFailed] = useState(false);
  function move(scale: number, from: Point = origin, to: Point = from) {
    if (!stage.current || !image.current?.naturalWidth) return;
    const { clientWidth: width, clientHeight: height } = stage.current;
    const { naturalWidth, naturalHeight } = image.current;
    const fit = Math.min(width / naturalWidth, height / naturalHeight);
    const old = current.current;
    // Keep the image point between the fingers stationary and keep the photo in reach.
    const nextScale = Math.min(4, Math.max(1, scale));
    const axis = (oldOffset: number, start: number, end: number, size: number, screen: number) => {
      const limit = Math.max(0, (size * fit * nextScale - screen) / 2);
      return Math.max(-limit, Math.min(limit, end - (start - oldOffset) * (nextScale / old.scale)));
    };
    const next =
      nextScale === 1
        ? origin
        : {
            scale: nextScale,
            x: axis(old.x, from.x, to.x, naturalWidth, width),
            y: axis(old.y, from.y, to.y, naturalHeight, height),
          };
    if (next.scale !== old.scale || next.x !== old.x || next.y !== old.y) {
      current.current = next;
      setView(next);
    }
  }

  const { start, drag, end } = useCoverGestures(current, move);
  useCoverResize(stage, current, move);

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black" />
        <Dialog.Content
          aria-describedby={undefined}
          className="dark fixed inset-0 z-[71] overflow-hidden overscroll-none bg-black"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            returnFocus();
          }}
        >
          <Dialog.Title className="sr-only">角色封面大图</Dialog.Title>
          <div
            ref={stage}
            className="absolute inset-0 touch-none select-none overflow-hidden"
            onPointerDown={start}
            onPointerMove={drag}
            onPointerUp={end}
            onPointerCancel={end}
            onLostPointerCapture={end}
          >
            {failed ? (
              <p className="grid h-full place-items-center text-sm text-white/70">
                封面暂时无法加载
              </p>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- Show the original cover at its native aspect ratio.
              <img
                ref={image}
                src={src}
                alt={`${name}的角色封面`}
                draggable={false}
                onError={() => setFailed(true)}
                className="h-full w-full object-contain"
                style={{ transform: `translate3d(${view.x}px,${view.y}px,0) scale(${view.scale})` }}
              />
            )}
          </div>
          <Dialog.Close asChild>
            <button
              type="button"
              aria-label="关闭大图"
              className={`${control} right-[calc(env(safe-area-inset-right)+0.75rem)] top-[calc(env(safe-area-inset-top)+0.75rem)]`}
            >
              <X className="size-5" aria-hidden />
            </button>
          </Dialog.Close>
          {!failed && (
            <button
              type="button"
              aria-label={view.scale > 1 ? '还原图片' : '放大图片'}
              onClick={() => move(current.current.scale > 1 ? 1 : 2)}
              className={`${control} right-[calc(env(safe-area-inset-right)+0.75rem)] bottom-[calc(env(safe-area-inset-bottom)+0.75rem)]`}
            >
              {view.scale > 1 ? (
                <ZoomOut className="size-5" aria-hidden />
              ) : (
                <ZoomIn className="size-5" aria-hidden />
              )}
            </button>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
