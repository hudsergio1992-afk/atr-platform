import { MouseEvent, useRef } from "react";

/**
 * Подробности строк открываются двойным нажатием — одиночное при просмотре их не раскрывает.
 * Своя проверка вместо onDoubleClick: на телефоне двойной тап надёжно ловится только так.
 * Использование: const dbl = useDoubleTap(); <tr onClick={dbl(id, () => open(id))}>
 */
export function useDoubleTap(windowMs = 400) {
  const last = useRef<{ key: string; at: number } | null>(null);
  return (key: string, action: () => void) => (e: MouseEvent) => {
    const prev = last.current;
    if (prev && prev.key === key && e.timeStamp - prev.at < windowMs) {
      last.current = null;
      window.getSelection()?.removeAllRanges();
      action();
    } else {
      last.current = { key, at: e.timeStamp };
    }
  };
}

export const DOUBLE_TAP_HINT = "Двойное нажатие — подробности";
