pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ADDMOD_() {
    signal input in[7];
    signal output out[2];

    signal in1[2] <== [in[1], in[2]];
    signal in2[2] <== [in[3], in[4]];
    signal in3[2] <== [in[5], in[6]];

    in[0] === 1 << 8;
    CheckBus256()(in2);
    CheckBus256()(in3);

    signal result[2] <== AddMod256_unsafe()(in1, in2, in3);
    signal safeDivisor[2] <== _SafeDivisor()(in3);
    signal rangeCheck <== LessThan256()(result, safeDivisor);
    rangeCheck === 1;
    out <== result;
}

component main {public [in]} = ADDMOD_();
