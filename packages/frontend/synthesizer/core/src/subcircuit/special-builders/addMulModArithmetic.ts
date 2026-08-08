import {
  freezeComposition,
  type ArithmeticSubcircuitMapping,
} from '../arithmeticSubcircuitComposition.ts';

const createAddModArithmeticMapping = (): ArithmeticSubcircuitMapping => Object.freeze({
  operation: 'ADDMOD',
  composition: freezeComposition({
    placementStrategy: 'generic',
    constants: [],
    numSteps: 3,
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
        subcircuit: 'ADDMODPrepare',
        usage: 'ADDMODPrepare',
        selector: 1n << 8n,
        inputs: [
          { kind: 'selector' },
          { kind: 'operand', index: 0 },
          { kind: 'operand', index: 1 },
          { kind: 'operand', index: 2 },
        ],
        outputs: [
          { kind: 'step-output', index: 0 },
          { kind: 'step-output', index: 1 },
          { kind: 'step-output', index: 2 },
          { kind: 'step-output', index: 3 },
          { kind: 'step-output', index: 4 },
          { kind: 'step-output', index: 5 },
          { kind: 'step-output', index: 6 },
          { kind: 'step-output', index: 7 },
          { kind: 'step-output', index: 8 },
          { kind: 'step-output', index: 9 },
          { kind: 'step-output', index: 10 },
          { kind: 'step-output', index: 11 },
          { kind: 'step-output', index: 12 },
          { kind: 'step-output', index: 13 },
          { kind: 'step-output', index: 14 },
          { kind: 'step-output', index: 15 },
          { kind: 'step-output', index: 16 },
          { kind: 'step-output', index: 17 },
          { kind: 'step-output', index: 18 },
        ],
      },
      {
        subcircuit: 'ADDMODVerify',
        usage: 'ADDMODVerify',
        selector: null,
        inputs: [
          { kind: 'step-output', index: 0 },
          { kind: 'step-output', index: 1 },
          { kind: 'step-output', index: 2 },
          { kind: 'step-output', index: 3 },
          { kind: 'step-output', index: 4 },
          { kind: 'step-output', index: 5 },
          { kind: 'step-output', index: 6 },
          { kind: 'step-output', index: 7 },
          { kind: 'step-output', index: 8 },
          { kind: 'step-output', index: 9 },
          { kind: 'step-output', index: 10 },
          { kind: 'step-output', index: 11 },
          { kind: 'step-output', index: 12 },
          { kind: 'step-output', index: 13 },
          { kind: 'step-output', index: 14 },
          { kind: 'step-output', index: 15 },
          { kind: 'step-output', index: 16 },
          { kind: 'step-output', index: 17 },
          { kind: 'step-output', index: 18 },
        ],
        outputs: [{ kind: 'result', index: 0 }],
      },
    ],
  }),
});

const createMulModArithmeticMapping = (): ArithmeticSubcircuitMapping => Object.freeze({
  operation: 'MULMOD',
  composition: freezeComposition({
    placementStrategy: 'generic',
    constants: [],
    numSteps: 1,
    numOperands: 3,
    numResults: 1,
    steps: [
      {
        subcircuit: 'MULMOD',
        usage: 'MULMOD',
        selector: null,
        inputs: [
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
    createAddModArithmeticMapping(),
    createMulModArithmeticMapping(),
  ]);
