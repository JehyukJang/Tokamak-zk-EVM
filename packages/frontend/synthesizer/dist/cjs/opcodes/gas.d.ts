import type { RunState } from '../interpreter.js';
import type { Common } from '@ethereumjs/common/dist/esm/index.js';
/**
 * This file returns the dynamic parts of opcodes which have dynamic gas
 * These are not pure functions: some edit the size of the memory
 * These functions are therefore not read-only
 */
export interface AsyncDynamicGasHandler {
    (runState: RunState, gas: bigint, common: Common): Promise<bigint>;
}
export interface SyncDynamicGasHandler {
    (runState: RunState, gas: bigint, common: Common): bigint;
}
export declare const dynamicGasHandlers: Map<number, AsyncDynamicGasHandler | SyncDynamicGasHandler>;
//# sourceMappingURL=gas.d.ts.map