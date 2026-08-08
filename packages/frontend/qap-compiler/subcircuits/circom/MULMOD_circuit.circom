pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template MULMOD_() {
    signal input in[7];
    signal output out[2];

    signal in1[2] <== [in[1], in[2]];
    signal in2[2] <== [in[3], in[4]];
    signal in3[2] <== [in[5], in[6]];

    in[0] === 1 << 9;

    out <== MulMod256()(in1, in2, in3);
}

component main {public [in]} = MULMOD_();
