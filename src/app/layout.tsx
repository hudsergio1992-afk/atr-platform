import type { Metadata } from "next";
import "./globals.css";
import ModuleNav from "@/components/ModuleNav";
import AuthGate from "@/components/AuthGate";

export const metadata: Metadata = {
  title: "Стройплатформа АТР",
  description: "Платформа управления строительными объектами ООО «АгроТехРешение»",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <div className="shell">
          <AuthGate>
            <ModuleNav />

            {children}
          </AuthGate>
        </div>
      </body>
    </html>
  );
}
