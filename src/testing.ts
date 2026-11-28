// Lets a test observe the isolate termination path without exhausting its runner.
import {
  TERMINATOR_TRAP_KEY,
  type TerminatorTrap,
  type TerminatorTrapSlot,
} from "./terminator-trap.ts";

// Restore callbacks from either side of a module reload share the same
// retired wrappers, just as the runtime shares the active trap slot.
const RETIRED_TRAPS_KEY = Symbol.for(
  "@curlewlabs-com/worker-lazy/retired-traps",
);
type TestingSlot = TerminatorTrapSlot & {
  [RETIRED_TRAPS_KEY]?: WeakMap<TerminatorTrap, TerminatorTrap | undefined>;
};

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
  const slot = globalThis as TestingSlot;
  const retired =
    slot[RETIRED_TRAPS_KEY] ??
    new WeakMap<TerminatorTrap, TerminatorTrap | undefined>();
  slot[RETIRED_TRAPS_KEY] = retired;
  const previous = slot[TERMINATOR_TRAP_KEY];
  // Each registration needs its own identity even if the callback is reused.
  const trap: TerminatorTrap = (reason) => onTerminate(reason);
  slot[TERMINATOR_TRAP_KEY] = trap;

  return () => {
    if (retired.has(trap)) return;
    retired.set(trap, previous);
    if (slot[TERMINATOR_TRAP_KEY] !== trap) return;

    let next = previous;
    while (next !== undefined && retired.has(next)) {
      next = retired.get(next);
    }
    slot[TERMINATOR_TRAP_KEY] = next;
  };
}
