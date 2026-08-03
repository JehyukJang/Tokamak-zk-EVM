pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template BYTE_() {
    signal input in[5];
    signal output out[2];
    signal index[2] <== [in[1], in[2]];
    signal value[2] <== [in[3], in[4]];

    in[0] === 1 << 26;
    out <== Byte256()(index, value);
}

component main {public [in]} = BYTE_();
