// The trap slot lives on globalThis so it survives a test runner reloading
// the module graph after installing a trap.
export const TERMINATOR_TRAP_KEY = "__deferredLoadTerminatorForTest";

export type TerminatorTrap = (reason: string) => never;
export type TerminatorTrapSlot = {
  [TERMINATOR_TRAP_KEY]?: TerminatorTrap | undefined;
};
