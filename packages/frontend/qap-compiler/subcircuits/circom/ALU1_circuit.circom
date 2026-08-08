pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ALU1_() {
    var NOT_NODE = (1 << 24) - 1;

    signal input in[5];
    signal output out[2];

    signal selector <== in[0];
    signal in1[2] <== [in[1], in[2]];
    signal in2[2] <== [in[3], in[4]];

    component in1Bits[2];
    component in2Bits[2];
    signal in1Words[4];
    signal in2Words[4];
    for (var limb = 0; limb < 2; limb++) {
        in1Bits[limb] = Num2Bits(128);
        in2Bits[limb] = Num2Bits(128);
        in1Bits[limb].in <== in1[limb];
        in2Bits[limb].in <== in2[limb];

        var in1Low = 0;
        var in1High = 0;
        var in2Low = 0;
        var in2High = 0;
        for (var bit = 0; bit < 64; bit++) {
            in1Low += in1Bits[limb].out[bit] * (1 << bit);
            in1High += in1Bits[limb].out[bit + 64] * (1 << bit);
            in2Low += in2Bits[limb].out[bit] * (1 << bit);
            in2High += in2Bits[limb].out[bit + 64] * (1 << bit);
        }
        in1Words[2 * limb] <== in1Low;
        in1Words[2 * limb + 1] <== in1High;
        in2Words[2 * limb] <== in2Low;
        in2Words[2 * limb + 1] <== in2High;
    }

    component add = Add256_unsafe();
    add.in1 <== in1;
    add.in2 <== in2;

    component mul = Mul256TruncatedFrom64_unsafe();
    mul.in1 <== in1Words;
    mul.in2 <== in2Words;

    component sub = Sub256_unsafe();
    sub.in1 <== in1;
    sub.in2 <== in2;

    component not = Not256_unsafe();
    not.in <== in1;

    // t is 0, 1, 3, or NOT_NODE for ADD, MUL, SUB, or NOT.
    signal t <== selector / 2 - 1;
    signal basis2 <== t * (t - 1);
    signal basis3 <== basis2 * (t - 3);
    basis3 * (t - NOT_NODE) === 0;

    // Newton interpolation selects one of the four constrained word results.
    signal coefficient1[2];
    signal coefficient2[2];
    signal coefficient3[2];
    signal term1[2];
    signal term2[2];
    signal term3[2];
    for (var limb = 0; limb < 2; limb++) {
        coefficient1[limb]
            <== mul.out[limb] - add.out[limb];
        coefficient2[limb]
            <== add.out[limb] / 3
            - mul.out[limb] / 2
            + sub.out[limb] / 6;
        coefficient3[limb]
            <== (
                not.out[limb]
                - add.out[limb]
                - NOT_NODE * coefficient1[limb]
                - NOT_NODE * (NOT_NODE - 1) * coefficient2[limb]
            ) / (NOT_NODE * (NOT_NODE - 1) * (NOT_NODE - 3));
        term1[limb] <== t * coefficient1[limb];
        term2[limb] <== basis2 * coefficient2[limb];
        term3[limb] <== basis3 * coefficient3[limb];
        out[limb]
            <== add.out[limb] + term1[limb] + term2[limb] + term3[limb];
    }

    CheckBus256()(out);
}

component main {public [in]} = ALU1_();
