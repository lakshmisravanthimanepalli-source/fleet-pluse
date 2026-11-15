import { Observable, defer, finalize, shareReplay } from 'rxjs';

export class SingleFlight<T> {
  private inFlight: Observable<T> | null = null;

  run(factory: () => Observable<T>): Observable<T> {
    if (!this.inFlight) {
      const shared = defer(factory).pipe(
        finalize(() => {
          if (this.inFlight === shared) this.inFlight = null;
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
      this.inFlight = shared;
    }
    return this.inFlight;
  }

  clear(): void {
    this.inFlight = null;
  }
}
