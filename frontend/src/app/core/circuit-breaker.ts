interface CircuitState {
  failures: number[];
  openUntil: number;
  trialInFlight: boolean;
}

export type CircuitRoute = 'primary' | 'secondary' | 'trial';

import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class CircuitBreaker {
  private readonly states = new Map<string, CircuitState>();

  route(endpoint: string, now = Date.now()): CircuitRoute {
    const state = this.states.get(endpoint);
    if (!state?.openUntil) return 'primary';
    if (now < state.openUntil || state.trialInFlight) return 'secondary';
    state.trialInFlight = true;
    return 'trial';
  }

  recordFailure(endpoint: string, now = Date.now()): void {
    const state = this.state(endpoint);
    state.trialInFlight = false;
    state.failures = state.failures.filter((timestamp) => now - timestamp < 30_000);
    state.failures.push(now);
    if (state.failures.length >= 5) state.openUntil = now + 20_000;
  }

  recordSuccess(endpoint: string): void {
    const state = this.states.get(endpoint);
    if (!state) return;
    state.failures = [];
    state.openUntil = 0;
    state.trialInFlight = false;
  }

  releaseTrial(endpoint: string): void {
    const state = this.states.get(endpoint);
    if (state) state.trialInFlight = false;
  }

  private state(endpoint: string): CircuitState {
    let state = this.states.get(endpoint);
    if (!state) {
      state = { failures: [], openUntil: 0, trialInFlight: false };
      this.states.set(endpoint, state);
    }
    return state;
  }
}
