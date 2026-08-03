pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ALU6_() {
    signal input in[5];
    signal output out[2];

    in[0] === 1 << 24;

    component in1N2B[2];
    component in2N2B[2];
    component outB2N[2];
    for (var limb = 0; limb < 2; limb++) {
        in1N2B[limb] = Num2Bits(128);
        in2N2B[limb] = Num2Bits(128);
        outB2N[limb] = Bits2Num(128);
        in1N2B[limb].in <== in[1 + limb];
        in2N2B[limb].in <== in[3 + limb];
        for (var bit = 0; bit < 128; bit++) {
            outB2N[limb].in[bit] <== XOR()(in1N2B[limb].out[bit], in2N2B[limb].out[bit]);
        }
        out[limb] <== outB2N[limb].out;
    }
}

component main {public [in]} = ALU6_();
