import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Compact Chinese count for read-only metrics and interactive social controls. */
export function formatCompactCount(value: number): string {
  return value >= 10_000 ? `${(value / 10_000).toFixed(1).replace(/\.0$/, '')}万` : String(value);
}
