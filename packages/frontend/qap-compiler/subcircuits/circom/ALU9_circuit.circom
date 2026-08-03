pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ALU9_() {
    signal input in[5];
    signal output out[2];
    signal index[2] <== [in[1], in[2]];
    signal value[2] <== [in[3], in[4]];

    in[0] === 1 << 11;
    index[1] === 0;
    signal indexLowRange <== LessEqThan(128)([index[0], (1 << 128) - 1]);
    indexLowRange === 1;
    CheckBus()(value);

    signal rem[2];
    signal divisor[2];
    (out, rem, divisor) <== SignExtend256_unsafe()(index[0], value);
    signal rangeCheck <== LessThan256()(rem, divisor);
    rangeCheck === 1;
}

component main {public [in]} = ALU9_();
