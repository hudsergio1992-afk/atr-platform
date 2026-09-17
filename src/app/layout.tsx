import type { Metadata } from "next";
import "./globals.css";
import ModuleNav from "@/components/ModuleNav";

export const metadata: Metadata = {
  title: "Стройплатформа АТР",
  description: "Платформа управления строительными объектами ООО «АгроТехРешение»",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <div className="shell">
          <div className="topbar">
            <div className="brand">
              <span className="name">Стройплатформа АТР</span>
              <span className="sub">ООО «АгроТехРешение»</span>
            </div>
            <span className="role-chip">
              Роль: все роли (Руководство / РП / Прораб / Снабженец / Инженер ПТО)
            </span>
          </div>

          <ModuleNav />

          {children}
        </div>
      </body>
    </html>
  );
}
