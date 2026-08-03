import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type CircuitTester = {
  calculateWitness: (input: Record<string, bigint[]>, sanityCheck?: boolean) => Promise<unknown>;
};

type WasmTester = (
  circuitPath: string,
  options: { include: string[]; prime: string; O: number },
) => Promise<CircuitTester>;

const require = createRequire(import.meta.url);
const wasmTester = (require('circom_tester') as { wasm: WasmTester }).wasm;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '../..');
const include = [path.join(packageRoot, 'node_modules')];
const circuitPath = (name: string): string => path.join(__dirname, 'circom', `${name}.circom`);

const main = async (): Promise<void> => {
  const mul = await wasmTester(circuitPath('MulSoundnessClaim'), { include, prime: 'bls12381', O: 0 });
  await mul.calculateWitness({ lhs: [3n, 0n], rhs: [5n, 0n], claimed: [15n, 0n] }, true);
  await assert.rejects(
    mul.calculateWitness({ lhs: [3n, 0n], rhs: [5n, 0n], claimed: [14n, 0n] }, true),
    undefined,
    'MUL must reject the previously accepted forged result',
  );

  const divMod = await wasmTester(circuitPath('DivModSoundnessClaim'), { include, prime: 'bls12381', O: 0 });
  await divMod.calculateWitness(
    { dividend: [17n, 0n], divisor: [5n, 0n], claimedQuotient: [3n, 0n], claimedRemainder: [2n, 0n] },
    true,
  );
  await assert.rejects(
    divMod.calculateWitness(
      { dividend: [17n, 0n], divisor: [5n, 0n], claimedQuotient: [4n, 0n], claimedRemainder: [2n, 0n] },
      true,
    ),
    undefined,
    'DIV/MOD must reject an inconsistent quotient and remainder',
  );

  const shift = await wasmTester(circuitPath('ShiftSoundnessClaim'), { include, prime: 'bls12381', O: 0 });
  await shift.calculateWitness({ shift: [256n, 0n], value: [1n, 0n], claimed: [0n, 0n] }, true);
  await assert.rejects(
    shift.calculateWitness({ shift: [256n, 0n], value: [1n, 0n], claimed: [1n, 0n] }, true),
    undefined,
    'SHL must enforce the EVM oversized-shift result',
  );

  console.log('Adversarial arithmetic soundness tests passed');
};

void main();
