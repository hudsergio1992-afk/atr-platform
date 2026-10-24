"use client";

import { FormEvent, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { exportAllToExcel } from "@/lib/exportAll";

/**
 * Вход по почте и паролю (Supabase Auth). Без входа сайт показывает только форму.
 * Свободной регистрации нет: учётки заводит владелец в панели Supabase
 * (Authentication → Users → Add user). Сессия хранится в браузере и
 * подставляется во все запросы к базе — когда правила базы закроют
 * доступ «только для вошедших», данные будут видны только после входа.
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setSession(data.session);
      setChecked(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setChecked(true);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const topbar = (
    <div className="topbar">
      <div className="brand">
        <span className="name">Стройплатформа АТР</span>
        <span className="sub">ООО «АгроТехРешение»</span>
      </div>
      {session && (
        <div className="auth-user">
          <span className="role-chip">
            Роль: все роли (Руководство / РП / Прораб / Снабженец / Инженер ПТО)
          </span>
          <span className="auth-email" title="Вы вошли как">
            {session.user.email}
          </span>
          <ExportButton />
          <button className="btn btn-ghost btn-sm" onClick={() => setPwOpen(!pwOpen)}>
            Сменить пароль
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => supabase.auth.signOut()}>
            Выйти
          </button>
        </div>
      )}
    </div>
  );

  if (!checked) {
    return (
      <>
        {topbar}
        <p className="hint">Проверка входа…</p>
      </>
    );
  }

  if (!session) {
    return (
      <>
        {topbar}
        <LoginForm />
      </>
    );
  }

  return (
    <>
      {topbar}
      {pwOpen && <PasswordForm onClose={() => setPwOpen(false)} />}
      {children}
    </>
  );
}

/** Новый пароль для своей учётки — пока вы на сайте, старый вводить не нужно. */
function PasswordForm({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw.length < 8) return setMsg({ ok: false, text: "Пароль — не короче 8 символов." });
    if (pw !== pw2) return setMsg({ ok: false, text: "Пароли не совпадают." });
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) {
      const m = error.message.toLowerCase();
      setMsg({
        ok: false,
        text: m.includes("different from the old")
          ? "Новый пароль совпадает со старым — придумайте другой."
          : m.includes("weak") || m.includes("characters")
          ? "Слишком простой пароль — добавьте буквы и цифры."
          : `Не удалось сменить пароль: ${error.message}`,
      });
      return;
    }
    setPw("");
    setPw2("");
    setMsg({ ok: true, text: "Пароль изменён. Входите с ним на любом устройстве." });
  }

  return (
    <form className="auth-card auth-pw" onSubmit={submit}>
      <h2>Новый пароль</h2>
      <p className="hint">Старый пароль вводить не нужно — вы уже на сайте. Запишите новый в надёжное место.</p>
      <div className="field">
        <label htmlFor="pw-new">Новый пароль</label>
        <input id="pw-new" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pw-new2">Повторите пароль</label>
        <input id="pw-new2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </div>
      {msg && <div className={`banner show${msg.ok ? " is-ok" : ""}`}>{msg.text}</div>}
      <div className="auth-pw-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Закрыть
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Сохраняю…" : "Сохранить пароль"}
        </button>
      </div>
    </form>
  );
}

/** Резервная копия: все данные сайта одним Excel-файлом. */
function ExportButton() {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [note, setNote] = useState("");
  async function run() {
    setState("busy");
    setNote("");
    try {
      const n = await exportAllToExcel();
      setState("done");
      setNote(`Выгружено записей: ${n}`);
    } catch (e) {
      setState("error");
      setNote(e instanceof Error ? e.message : "Не удалось выгрузить");
    }
  }
  return (
    <button
      className="btn btn-ghost btn-sm"
      onClick={run}
      disabled={state === "busy"}
      title={note || "Резервная копия: все таблицы и список фото в один Excel-файл"}
    >
      {state === "busy" ? "Выгрузка…" : state === "done" ? "Выгружено ✓" : state === "error" ? "Ошибка выгрузки" : "Выгрузить всё в Excel"}
    </button>
  );
}

function loginErrorText(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) return "Неверная почта или пароль.";
  if (m.includes("email not confirmed")) return "Почта не подтверждена. В Supabase у учётки нужна отметка «Auto confirm user».";
  if (m.includes("fetch") || m.includes("network")) return "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.";
  return `Не удалось войти: ${message}`;
}

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError("Введите почту и пароль.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (err) setError(loginErrorText(err.message));
  }

  return (
    <form className="auth-card" onSubmit={submit}>
      <h2>Вход</h2>
      <p className="hint">Доступ только для сотрудников. Учётную запись выдаёт администратор.</p>
      <div className="field">
        <label htmlFor="auth-email">Почта</label>
        <input
          id="auth-email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
      </div>
      <div className="field">
        <label htmlFor="auth-password">Пароль</label>
        <input
          id="auth-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error && <div className="banner show">{error}</div>}
      <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
        {busy ? "Вход…" : "Войти"}
      </button>
    </form>
  );
}
