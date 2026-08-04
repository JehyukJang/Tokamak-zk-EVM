import {
  freezeComposition,
  type ArithmeticSubcircuitMapping,
} from '../arithmeticSubcircuitComposition.ts';

const createAddMulModArithmeticMapping = (
  operation: 'ADDMOD' | 'MULMOD',
  selector: bigint,
): ArithmeticSubcircuitMapping => Object.freeze({
  operation,
  composition: freezeComposition({
    placementStrategy: 'generic',
    constants: [],
    numSteps: 2,
    numOperands: 3,
    numResults: 1,
    steps: [
      {
        subcircuit: 'CheckBus256',
        usage: 'CheckBus256',
        selector: null,
        inputs: [{ kind: 'operand', index: 0 }],
        outputs: [],
      },
      {
        subcircuit: operation,
        usage: operation,
        selector,
        inputs: [
          { kind: 'selector' },
          { kind: 'operand', index: 0 },
          { kind: 'operand', index: 1 },
          { kind: 'operand', index: 2 },
        ],
        outputs: [{ kind: 'result', index: 0 }],
      },
    ],
  }),
});

export const createAddMulModArithmeticMappings = (): readonly ArithmeticSubcircuitMapping[] =>
  Object.freeze([
    createAddMulModArithmeticMapping('ADDMOD', 1n << 8n),
    createAddMulModArithmeticMapping('MULMOD', 1n << 9n),
  ]);
