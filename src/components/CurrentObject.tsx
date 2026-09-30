import Link from "next/link";

/**
 * Объект модуля — только для чтения: выбирается один раз на дашборде
 * и открывается на всех вкладках. Здесь его можно лишь увидеть и перейти к смене.
 */
export default function CurrentObject({ name, loading }: { name: string | null; loading: boolean }) {
  return (
    <>
      <span className="obj-picker-label">Объект</span>
      <span className="obj-current">{loading ? "Загрузка…" : name || "Объектов нет"}</span>
      <Link href="/dashboard" className="obj-change" title="Объект выбирается на дашборде и открывается на всех вкладках">
        сменить на дашборде
      </Link>
    </>
  );
}
