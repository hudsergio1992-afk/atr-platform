"use client";

import { useEffect, useState } from "react";

/**
 * Показывается, когда в базе нет таблиц под данные модуля.
 * Создать их из приложения нельзя — у публичного ключа нет таких прав,
 * поэтому владелец базы выполняет подготовку один раз. Здесь для этого
 * есть всё: текст, кнопка копирования и ссылка прямо в редактор Supabase.
 */
export default function SchemaSetup() {
  const [sql, setSql] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/schema.sql")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => {
        if (alive) setSql(t);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Буфер обмена может быть недоступен — тогда остаётся выделить текст руками.
      setOpen(true);
    }
  }

  return (
    <div className="setup">
      <h3>Хранилище ещё не подготовлено</h3>
      <p>
        Данные лежат не в самом сайте, а в отдельной базе. Для объектов место там уже есть,
        а для этапов графика и недельных заданий его нужно создать — один раз. Сайт сделать
        это сам не может: он работает под ключом, которому запрещено менять устройство базы.
      </p>
      <ol className="setup-steps">
        <li>
          Нажмите <b>Скопировать</b> — текст подготовки уйдёт в буфер обмена.
        </li>
        <li>
          Откройте{" "}
          <a href="https://supabase.com/dashboard/project/_/sql/new" target="_blank" rel="noreferrer">
            редактор запросов Supabase
          </a>{" "}
          и выберите свой проект.
        </li>
        <li>Вставьте текст в пустое окно (Ctrl+V) и нажмите зелёную кнопку <b>Run</b>.</li>
        <li>
          Внизу появится <b>Success. No rows returned</b> — готово. Вернитесь сюда и обновите
          страницу.
        </li>
      </ol>
      <div className="setup-actions">
        <button className="btn btn-primary" style={{ marginLeft: 0 }} onClick={copy} disabled={!sql}>
          {copied ? "Скопировано" : "Скопировать"}
        </button>
        <button className="btn btn-ghost" onClick={() => setOpen((v) => !v)} disabled={!sql}>
          {open ? "Скрыть текст" : "Показать текст"}
        </button>
        <a className="btn btn-ghost" href="/schema.sql" target="_blank" rel="noreferrer">
          Открыть файлом
        </a>
      </div>
      {failed && (
        <p className="hint">
          Не удалось загрузить текст подготовки. Возьмите его из файла supabase/schema.sql
          в репозитории проекта.
        </p>
      )}
      {open && sql && <pre className="setup-sql">{sql}</pre>}
      <p className="hint">
        Существующие данные это не затронет: текст написан так, что уже созданное он не трогает,
        а добавляет только недостающее.
      </p>
    </div>
  );
}
