/**
 * Сжатие фото в браузере перед загрузкой в хранилище.
 *
 * Снимки с телефона на площадке — по 5–10 МБ, а связь там часто слабая.
 * Пережимаем в JPEG с ограничением по длинной стороне прямо на клиенте,
 * до отправки в Supabase Storage.
 */
export function compressImage(file: File, maxSide = 1920, quality = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxSide || height > maxSide) {
        if (width >= height) {
          height = Math.round((height * maxSide) / width);
          width = maxSide;
        } else {
          width = Math.round((width * maxSide) / height);
          height = maxSide;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("Холст 2D недоступен в этом браузере"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(url);
          if (blob) resolve(blob);
          else reject(new Error("Не удалось сжать изображение"));
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Не удалось прочитать файл изображения"));
    };
    img.src = url;
  });
}

/** Случайное безопасное имя файла в хранилище — пережатое фото всегда .jpg. */
export function randomStorageName(originalName: string): string {
  const base = originalName
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]+/g, "_")
    .slice(0, 40);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${Date.now()}_${rand}_${base || "photo"}.jpg`;
}
