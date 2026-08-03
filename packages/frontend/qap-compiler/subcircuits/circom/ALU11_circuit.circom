pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ALU11_() {
    signal input in[5];
    signal output out[2];
    signal shift[2] <== [in[1], in[2]];
    signal value[2] <== [in[3], in[4]];

    in[0] === 1 << 27;
    shift[1] === 0;
    CheckBus128()(shift[0]);
    CheckBus256()(value);

    signal (expShift[2], isShiftGt255) <== FindShiftingTwosPower256(8)(shift[0]);
    component left = Mul256_unsafe();
    left.in1 <== value;
    left.in2 <== expShift;
    out <== left.out;

    signal lowLimbRange <== LessEqThan(128)([left.out[0], (1 << 128) - 1]);
    lowLimbRange === 1;
}

component main {public [in]} = ALU11_();
