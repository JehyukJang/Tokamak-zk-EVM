import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { equalsBytes } from 'ethereum-cryptography/utils';
import { FORMAT, MAGIC } from './constants.js';
export const EOFBYTES = new Uint8Array([FORMAT, MAGIC]);
export const EOFHASH = keccak256(EOFBYTES);
/**
 * Returns `true` if `code` is an EOF contract, otherwise `false`
 * @param code Code to test
 */
export function isEOF(code) {
    const check = code.subarray(0, EOFBYTES.length);
    return equalsBytes(EOFBYTES, check);
}
//# sourceMappingURL=util.js.map