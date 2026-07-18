/**
 * Крошечный пер-инстансный семафор (p-limit без зависимости): ограничивает число
 * ОДНОВРЕМЕННЫХ тяжёлых операций на процесс. Без него N параллельных загрузок видео
 * = N одновременных ffmpeg/sharp на инстансе — CPU-шторм давит event-loop и латентность
 * всего API (перф-ревью 2026-07-18). Очередь FIFO, release в finally, ошибка задачи
 * слот не съедает.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  private tryAcquire(): boolean {
    if (this.active < this.limit) {
      this.active += 1;
      return true;
    }
    return false;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // while, не if: проснувшийся ждун перепроверяет слот — параллельный новичок мог
    // проскочить между release и резюмом (иначе возможен overshoot лимита).
    while (!this.tryAcquire()) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

/**
 * Общий лимитер медиа-CPU процесса: ffmpeg (постеры/волна/подготовка STT) и sharp
 * (варианты изображений). 3 слота — достаточно для пропускной способности, мало
 * для того, чтобы задушить инстанс; хвост очереди добирают крон-ретраи конвейера.
 */
export const mediaSemaphore = new Semaphore(3);
