"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MODULES } from "@/lib/types";

/** Нав-меню модулей: готовые — ссылки с подсветкой текущего, остальные — заглушки «скоро». */
export default function ModuleNav() {
  const pathname = usePathname();

  return (
    <nav className="modnav" aria-label="Модули">
      {MODULES.map((m) =>
        m.ready ? (
          <Link
            key={m.key}
            href={m.href}
            className={`modtab link${pathname?.startsWith(m.href) ? " active" : ""}`}
            aria-current={pathname?.startsWith(m.href) ? "page" : undefined}
          >
            {m.label}
          </Link>
        ) : (
          <span key={m.key} className="modtab" title="Скоро">
            {m.label} <span className="soon">скоро</span>
          </span>
        )
      )}
    </nav>
  );
}
