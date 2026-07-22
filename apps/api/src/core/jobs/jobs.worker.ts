import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { JOB_LIMITS } from '@superapp/shared';
import { ClaimedJob, JobsService } from './jobs.service';
import { JobDiscardError, JobsRegistry } from './jobs.registry';

interface QueueState {
  inFlight: number;
  timer: NodeJS.Timeout | null;
  passing: boolean;
  /** Пинок пришёл во время прохода → сразу новый проход после текущего. */
  pending: boolean;
  /** Слотов на инстанс для этой очереди (min queueConcurrency её типов). */
  concurrency: number;
}

/**
 * In-process воркер движка джобов: по поллеру на очередь (пауза 1с + мгновенные
 * нуджи после enqueue/освобождения слота), claim пачкой в пределах свободных
 * слотов, исполнение обработчиков параллельно под per-queue cap. Мульти-инстанс
 * безопасен из коробки (SKIP LOCKED в claim). Дренаж на остановке: перестаём
 * клеймить, ждём in-flight до JOB_LIMITS.shutdownDrainMs — недожатое вернёт
 * reaper по аренде.
 */
@Injectable()
export class JobsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsWorker.name);
  private readonly states = new Map<string, QueueState>();
  private stopped = false;

  constructor(
    private readonly registry: JobsRegistry,
    private readonly jobs: JobsService,
  ) {}

  /** После ВСЕХ onModuleInit — регистрации потребителей уже собраны (как EventBus). */
  onApplicationBootstrap(): void {
    this.jobs.setNudger((queue) => this.wake(queue));
    const queues = this.registry.queues();
    for (const queue of queues) {
      this.states.set(queue, {
        inFlight: 0,
        timer: null,
        passing: false,
        pending: false,
        concurrency: this.registry.concurrencyOf(queue),
      });
      this.schedule(queue, 0);
    }
    if (queues.length > 0) {
      this.logger.log(
        `worker started: queues [${queues.join(', ')}], types: ${this.registry.all().length}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const st of this.states.values()) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
    }
    const deadline = Date.now() + JOB_LIMITS.shutdownDrainMs;
    while (Date.now() < deadline && this.totalInFlight() > 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const left = this.totalInFlight();
    if (left > 0) {
      this.logger.warn(`${left} job(s) still in flight at shutdown — leases will redrive them`);
    }
  }

  /** Пинок очереди: немедленный проход (или пометка «повторить», если проход уже идёт). */
  wake(queue: string): void {
    const st = this.states.get(queue);
    if (!st || this.stopped) return;
    if (st.passing) {
      st.pending = true;
      return;
    }
    this.schedule(queue, 0);
  }

  private schedule(queue: string, delayMs: number): void {
    if (this.stopped) return;
    const st = this.states.get(queue);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => void this.pass(queue), delayMs);
  }

  /** Один проход поллера: добрать джобов в свободные слоты и запустить (не дожидаясь). */
  private async pass(queue: string): Promise<void> {
    const st = this.states.get(queue);
    if (!st || this.stopped) return;
    if (st.passing) {
      st.pending = true;
      return;
    }
    st.passing = true;
    try {
      const capacity = Math.min(st.concurrency - st.inFlight, JOB_LIMITS.claimBatch);
      if (capacity > 0) {
        const claimed = await this.jobs.claim(queue, this.registry.typesOf(queue), capacity);
        for (const job of claimed) void this.execute(queue, job);
        // Полная пачка → в очереди, вероятно, есть ещё — не ждать интервал.
        if (claimed.length === capacity) st.pending = true;
      }
    } catch (err) {
      this.logger.warn(
        `pass(${queue}) failed: ${String((err as Error)?.message ?? err)}`,
      );
    } finally {
      st.passing = false;
      const again = st.pending;
      st.pending = false;
      this.schedule(queue, again ? 0 : JOB_LIMITS.pollIntervalMs);
    }
  }

  private async execute(queue: string, job: ClaimedJob): Promise<void> {
    const st = this.states.get(queue);
    if (!st) return;
    st.inFlight++;
    const def = this.registry.get(job.type);
    try {
      if (!def) {
        // Теоретический случай: claim фильтрует по зарегистрированным типам.
        throw new JobDiscardError(`нет обработчика для типа "${job.type}"`);
      }
      await this.jobs.setLease(job.id, job.attempts, def.leaseMs);
      await def.handler(job.payload, {
        jobId: job.id,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
      });
      await this.jobs.complete(job.id, job.attempts);
    } catch (err) {
      await this.jobs
        .fail(job, def, err)
        .catch((e) =>
          this.logger.error(
            `fail() write failed for job ${job.id}: ${String((e as Error)?.message ?? e)}`,
          ),
        );
    } finally {
      st.inFlight--;
      // Освободился слот → добрать очередь сразу (проход дешёвый: 1 индексный запрос).
      this.wake(queue);
    }
  }

  private totalInFlight(): number {
    let n = 0;
    for (const st of this.states.values()) n += st.inFlight;
    return n;
  }
}
