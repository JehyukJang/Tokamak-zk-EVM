import { bytesToHex, setLengthLeft } from "@ethereumjs/util/index.js";
import { ripemd160 } from 'ethereum-cryptography/ripemd160.js';
import { OOGResult } from '../evm.js';
import { gasLimitCheck } from './util.js';
import { getPrecompileName } from './index.js';
export function precompile03(opts) {
    const pName = getPrecompileName('03');
    const data = opts.data;
    let gasUsed = opts.common.param('ripemd160Gas');
    gasUsed += opts.common.param('ripemd160WordGas') * BigInt(Math.ceil(data.length / 32));
    if (!gasLimitCheck(opts, gasUsed, pName)) {
        return OOGResult(opts.gasLimit);
    }
    const hash = setLengthLeft(ripemd160(data), 32);
    if (opts._debug !== undefined) {
        opts._debug(`${pName} return hash=${bytesToHex(hash)}`);
    }
    return {
        executionGasUsed: gasUsed,
        returnValue: setLengthLeft(ripemd160(data), 32),
    };
}
//# sourceMappingURL=03-ripemd160.js.map