pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template MULMOD_() {
    signal input in[7];
    signal output out[2];

    signal in1[2] <== [in[1], in[2]];
    signal in2[2] <== [in[3], in[4]];
    signal in3[2] <== [in[5], in[6]];

    in[0] === 1 << 9;
    CheckBus256()(in2);
    CheckBus256()(in3);

    signal result[2] <== MulMod256_unsafe()(in1, in2, in3);
    signal isZeroModulus <== IsZero256()(in3);
    signal rangeCheck <== LessThan256()(result, in3);
    rangeCheck + isZeroModulus === 1;
    out <== result;
}

component main {public [in]} = MULMOD_();
