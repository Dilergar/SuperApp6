import { Injectable } from '@nestjs/common';
import { Subject, filter, Observable } from 'rxjs';

/**
 * Internal event bus for module-to-module communication.
 *
 * Modules should NOT call each other directly.
 * Instead they emit events, and other modules subscribe.
 *
 * Example:
 *   Tasks module emits 'task.completed' ->
 *   Calendar module listens and updates the calendar event ->
 *   Coins module listens and awards coins
 *
 * This keeps modules decoupled and allows adding new modules
 * without modifying existing ones.
 */

export interface AppEvent {
  type: string;
  payload: Record<string, unknown>;
  emittedBy: string; // module name
  timestamp: Date;
}

@Injectable()
export class EventBusService {
  private readonly eventStream = new Subject<AppEvent>();

  /** Emit an event to all subscribers */
  emit(type: string, payload: Record<string, unknown>, emittedBy: string): void {
    this.eventStream.next({
      type,
      payload,
      emittedBy,
      timestamp: new Date(),
    });
  }

  /** Subscribe to events of a specific type */
  on(eventType: string): Observable<AppEvent> {
    return this.eventStream.pipe(
      filter((event) => event.type === eventType),
    );
  }

  /** Subscribe to all events matching a pattern (e.g. 'task.*') */
  onPattern(pattern: string): Observable<AppEvent> {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return this.eventStream.pipe(
      filter((event) => regex.test(event.type)),
    );
  }
}
