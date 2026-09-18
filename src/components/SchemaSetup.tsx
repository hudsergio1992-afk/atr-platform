"use client";

import { useCallback, useEffect, useState } from "react";
import { supabaseProjectRef } from "@/lib/supabaseClient";
import {
  detectSchemaGap,
  gapIsEmpty,
  gapWords,
  patchFor,
  SchemaGap,
} from "@/lib/schemaPatch";

/**
 * Показывается, когда база отстала от приложения: нет таблиц или колонок.
 * Создать их из приложения нельзя — у публичного ключа нет таких прав,
 * поэтому владелец базы выполняет подготовку сам. Здесь для этого есть всё:
 * что именно отстало, короткий текст ровно под это и ссылка в редактор.
 */
export default function SchemaSetup({ onRecheck }: { onRecheck?: () => void }) {
  const projectRef = supabaseProjectRef();
  // Ссылка на редактор запросов именно того проекта, в который ходит сайт:
  // с «_» Supabase откроет последний использованный, а он бывает соседним.
  const editorUrl = projectRef
    ? `https://supabase.com/dashboard/project/${projectRef}/sql/new`
    : "https://supabase.com/dashboard/project/_/sql/new";

  const [sql, setSql] = useState<string>("");
  const [gap, setGap] = useState<SchemaGap | null>(null);
  const [patch, setPatch] = useState<string>("");
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  const text = full || !patch ? sql : patch;
  const lines = text ? text.split("\n").filter((l) => l.trim()).length : 0;

  const probe = useCallback(async (schemaSql: string) => {
    const found = await detectSchemaGap();
    setGap(found);
    setPatch(patchFor(schemaSql, found));
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/schema.sql")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(async (t) => {
        if (!alive) return;
        setSql(t);
        await probe(t);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [probe]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Буфер обмена может быть недоступен — тогда остаётся выделить текст руками.
      setOpen(true);
    }
  }

  async function recheck() {
    if (sql) await probe(sql);
    onRecheck?.();
  }

  const missing = gap ? gapWords(gap) : [];

  return (
    <div className="setup">
      <h3>Хранилище отстало от приложения</h3>
      <p>
        Данные лежат не в самом сайте, а в отдельной базе, и её устройство обновляется
        отдельно. Сайт сделать это сам не может: он работает под ключом, которому запрещено
        менять устройство базы. Нужен один запуск текста ниже — это займёт полминуты.
      </p>

      {missing.length > 0 && (
        <div className="setup-gap">
          <b>Чего не хватает прямо сейчас:</b>
          <ul>
            {missing.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {gap && gapIsEmpty(gap) && (
        <p className="setup-gap-ok">
          Сейчас база отвечает так, будто всё на месте. Если ошибка повторяется — запустите
          полный текст: он ничего не ломает.
        </p>
      )}

      <ol className="setup-steps">
        <li>
          Нажмите <b>Скопировать</b> — текст уйдёт в буфер обмена
          {patch && !full ? ` (${lines} строк вместо ${sql.split("\n").filter((l) => l.trim()).length})` : ""}.
        </li>
        <li>
          Откройте{" "}
          <a href={editorUrl} target="_blank" rel="noreferrer">
            редактор запросов Supabase
          </a>
          {projectRef ? <> — ссылка ведёт сразу в нужный проект.</> : <> и выберите свой проект.</>}
        </li>
        <li>Вставьте текст в пустое окно (Ctrl+V) и нажмите зелёную кнопку <b>Run</b>.</li>
        <li>
          Внизу появится <b>Success. No rows returned</b> — готово. Вернитесь сюда и нажмите
          «Проверить снова».
        </li>
      </ol>

      {projectRef && (
        <p className="setup-project">
          Сайт подключён к проекту Supabase <b className="mono">{projectRef}</b>. Готовить
          хранилище нужно именно в нём: если запустить текст в другом проекте, здесь ничего
          не изменится.
        </p>
      )}

      <div className="setup-actions">
        <button className="btn btn-primary" style={{ marginLeft: 0 }} onClick={copy} disabled={!text}>
          {copied ? "Скопировано" : patch && !full ? "Скопировать нужное" : "Скопировать"}
        </button>
        {patch && (
          <button className="btn btn-ghost" onClick={() => setFull((v) => !v)}>
            {full ? "Только нужное" : "Полная схема"}
          </button>
        )}
        <button className="btn btn-ghost" onClick={() => setOpen((v) => !v)} disabled={!text}>
          {open ? "Скрыть текст" : "Показать текст"}
        </button>
        <a className="btn btn-ghost" href="/schema.sql" target="_blank" rel="noreferrer">
          Открыть файлом
        </a>
        <button className="btn btn-ghost" onClick={recheck}>
          Проверить снова
        </button>
      </div>

      {failed && (
        <p className="hint">
          Не удалось загрузить текст подготовки. Возьмите его из файла supabase/schema.sql
          в репозитории проекта.
        </p>
      )}
      {open && text && <pre className="setup-sql">{text}</pre>}
      <p className="hint">
        Существующие данные это не затронет: текст написан так, что уже созданное он не
        трогает, а добавляет только недостающее. Повторный запуск тоже безопасен. Если
        Supabase покажет красную ошибку — пришлите её текст, разберём.
      </p>
    </div>
  );
}
