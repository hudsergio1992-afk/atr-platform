"use client";

import { useSyncExternalStore } from "react";
import { todayISO } from "@/lib/schedule";

/** Внешнего источника нет — значение не меняется после гидрации. */
const noopSubscribe = () => () => {};

/** false при рендере на сервере и в момент гидрации, true после неё. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

/**
 * Сегодняшняя дата по календарю пользователя.
 * На сервере — null: часовой пояс машины сборки не совпадает с поясом прораба,
 * а расхождение сломало бы гидрацию и все расчёты «% плана».
 */
export function useToday(): string | null {
  return useSyncExternalStore(
    noopSubscribe,
    todayISO,
    () => null
  );
}

/** Чтение настройки интерфейса из localStorage; недоступное хранилище — не ошибка. */
export function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* приватный режим или запрет хранилища — настройка просто не запомнится */
  }
}
