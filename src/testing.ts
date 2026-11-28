// Lets a test observe the isolate termination path without exhausting its runner.
import {
  TERMINATOR_TRAP_KEY,
  type TerminatorTrap,
  type TerminatorTrapSlot,
} from "./terminator-trap.ts";

export class DeferredLoadTerminated extends Error {
  constructor(reason: string) {
    super(`deferred-load isolate termination (test trap): ${reason}`);
    this.name = "DeferredLoadTerminated";
  }
}

export function installTerminatorTrap(
  onTerminate: TerminatorTrap = (reason) => {
    throw new DeferredLoadTerminated(reason);
  },
): () => void {
  const slot = globalThis as TerminatorTrapSlot;
  const previous = slot[TERMINATOR_TRAP_KEY];
  slot[TERMINATOR_TRAP_KEY] = onTerminate;
  return () => {
    slot[TERMINATOR_TRAP_KEY] = previous;
  };
}
