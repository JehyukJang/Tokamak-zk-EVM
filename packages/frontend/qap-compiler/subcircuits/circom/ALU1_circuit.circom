pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ALU1_() {
    var NUM_TOTAL_FUNCTIONS = 29;
    var NUM_SELECTOR_BITS = NUM_TOTAL_FUNCTIONS + 1;
    var NUM_ALU_FUNCTIONS = 6;

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

    signal b_selector[NUM_SELECTOR_BITS] <== Num2Bits(NUM_SELECTOR_BITS)(selector);
    signal unsupported_selector_sum <== b_selector[0] + b_selector[4] + b_selector[5] + b_selector[6] + b_selector[7] + b_selector[8] + b_selector[9] + b_selector[10] + b_selector[11] + b_selector[12] + b_selector[13] + b_selector[14] + b_selector[15] + b_selector[16] + b_selector[17] + b_selector[18] + b_selector[19] + b_selector[22] + b_selector[23] + b_selector[24] + b_selector[26] + b_selector[27] + b_selector[28] + b_selector[29];
    unsupported_selector_sum === 0;
    signal outs[NUM_ALU_FUNCTIONS][2];
    signal flags[NUM_ALU_FUNCTIONS];
    var ind = 0;

    component add = Add256_unsafe();
    add.in1 <== in1;
    add.in2 <== in2;
    outs[ind] <== add.out;
    flags[ind] <== b_selector[1];
    ind++;

    component mul = Mul256TruncatedFrom64_unsafe();
    mul.in1 <== in1Words;
    mul.in2 <== in2Words;
    outs[ind] <== mul.out;
    flags[ind] <== b_selector[2];
    ind++;

    component sub = Sub256_unsafe();
    sub.in1 <== in1;
    sub.in2 <== in2;
    outs[ind] <== sub.out;
    flags[ind] <== b_selector[3];
    ind++;

    signal is_upper_eq <== IsEqual()([in1[1], in2[1]]);
    signal is_lower_eq <== IsEqual()([in1[0], in2[0]]);
    signal is_eq <== is_upper_eq * is_lower_eq;

    outs[ind] <== [is_eq, 0];
    flags[ind] <== b_selector[20];
    ind++;

    component iszero = IsZero256();
    iszero.in <== in1;
    outs[ind] <== [iszero.out, 0];
    flags[ind] <== b_selector[21];
    ind++;

    component not = Not256_unsafe();
    not.in <== in1;
    outs[ind] <== not.out;
    flags[ind] <== b_selector[25];
    ind++;

    signal flags_sum <== flags[0] + flags[1] + flags[2] + flags[3] + flags[4] + flags[5];
    flags_sum === 1;

    component mux = ComplexMux256_checked(NUM_ALU_FUNCTIONS);
    mux.selector <== flags;
    mux.ins <== outs;
    out <== mux.out;

    CheckBus256()(out);
}

component main {public [in]} = ALU1_();
