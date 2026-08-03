pragma circom 2.1.6;
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/gates.circom";
include "../128bit/arithmetic.circom";
include "mux.circom";

template FindShiftingTwosPower256(N) {
    signal input shift;
    signal output twos_power[2], is_shift_gt_255;

    // case 1
    is_shift_gt_255 <== GreaterThan(N)([shift, 255]);
    // case 2
    signal is_shift_gt_127 <== GreaterThan(N)([shift, 127]);
    // case 3: !is_shift_gt_127

    signal shift_up_inter <== (shift - 128) * is_shift_gt_127;
    signal shift_up <== (1 - is_shift_gt_255) * shift_up_inter;
    signal shift_masked <== shift * (1 - is_shift_gt_127);

    // case 2 and 3
    signal (exp_shift_case2, exp_shift_case3) <== TwosExp128TwoInput()(shift_up, shift_masked);
    signal case23_out[2] <== Mux256()(is_shift_gt_127, [0, exp_shift_case2], [exp_shift_case3, 0]);
    twos_power <== Mux256()(is_shift_gt_255, [0, 0], case23_out);
}

template FindShiftingTwosPower256TwoInput(N1, N2) {
    signal input shift1, shift2;
    signal output twos_power1[2], is_shift1_gt_255, twos_power2[2], is_shift2_gt_255;

    // case 1
    is_shift1_gt_255 <== GreaterThan(N1)([shift1, 255]);
    is_shift2_gt_255 <== GreaterThan(N2)([shift2, 255]);
    // case 2
    signal is_shift1_gt_127 <== GreaterThan(N1)([shift1, 127]);
    signal is_shift2_gt_127 <== GreaterThan(N2)([shift2, 127]);
    // case 3: !is_shift_gt_127

    signal shift1_up_inter <== (shift1 - 128) * is_shift1_gt_127;
    signal shift1_up <== (1 - is_shift1_gt_255) * shift1_up_inter;
    signal shift1_masked <== shift1 * (1 - is_shift1_gt_127);

    signal shift2_up_inter <== (shift2 - 128) * is_shift2_gt_127;
    signal shift2_up <== (1 - is_shift2_gt_255) * shift2_up_inter;
    signal shift2_masked <== shift2 * (1 - is_shift2_gt_127);

    // case 2 and 3
    signal (exp_shift1_case2, exp_shift1_case3, exp_shift2_case2, exp_shift2_case3) <== TwosExp128FourInput()(shift1_up, shift1_masked, shift2_up, shift2_masked);
    signal case23_out1[2] <== Mux256()(is_shift1_gt_127, [0, exp_shift1_case2], [exp_shift1_case3, 0]);
    signal case23_out2[2] <== Mux256()(is_shift2_gt_127, [0, exp_shift2_case2], [exp_shift2_case3, 0]);
    twos_power1 <== Mux256()(is_shift1_gt_255, [0, 0], case23_out1);
    twos_power2 <== Mux256()(is_shift2_gt_255, [0, 0], case23_out2);
}

template Byte256() {
    signal input index[2], value[2];
    signal output out[2];

    component indexBits[2];
    component valueBits[2];
    for (var limb = 0; limb < 2; limb++) {
        indexBits[limb] = Num2Bits(128);
        valueBits[limb] = Num2Bits(128);
        indexBits[limb].in <== index[limb];
        valueBits[limb].in <== value[limb];
    }

    var oversizedSum = 0;
    for (var bit = 5; bit < 128; bit++) {
        oversizedSum += indexBits[0].out[bit];
    }
    for (var bit = 0; bit < 128; bit++) {
        oversizedSum += indexBits[1].out[bit];
    }
    signal inRange <== IsZero()(oversizedSum);

    signal selected[6][32];
    for (var byte = 0; byte < 32; byte++) {
        var sourceByte = 31 - byte;
        var byteValue = 0;
        for (var bit = 0; bit < 8; bit++) {
            if (sourceByte < 16) {
                byteValue += valueBits[0].out[8 * sourceByte + bit] * (1 << bit);
            } else {
                byteValue += valueBits[1].out[8 * (sourceByte - 16) + bit] * (1 << bit);
            }
        }
        selected[0][byte] <== byteValue;
    }

    for (var step = 0; step < 5; step++) {
        var active = 32 \ (1 << (step + 1));
        for (var candidate = 0; candidate < 32; candidate++) {
            if (candidate < active) {
                selected[step + 1][candidate] <== selected[step][2 * candidate]
                    + indexBits[0].out[step]
                    * (selected[step][2 * candidate + 1] - selected[step][2 * candidate]);
            } else {
                selected[step + 1][candidate] <== 0;
            }
        }
    }

    out[0] <== inRange * selected[5][0];
    out[1] <== 0;
}

template SignExtend256() {
    signal input index[2], value[2];
    signal output out[2];

    component indexBits[2];
    component valueBits[2];
    for (var limb = 0; limb < 2; limb++) {
        indexBits[limb] = Num2Bits(128);
        valueBits[limb] = Num2Bits(128);
        indexBits[limb].in <== index[limb];
        valueBits[limb].in <== value[limb];
    }

    var oversizedSum = 0;
    for (var bit = 5; bit < 128; bit++) {
        oversizedSum += indexBits[0].out[bit];
    }
    for (var bit = 0; bit < 128; bit++) {
        oversizedSum += indexBits[1].out[bit];
    }
    signal inRange <== IsZero()(oversizedSum);

    signal indexMatch[6][32];
    indexMatch[0][0] <== 1;
    for (var candidate = 1; candidate < 32; candidate++) {
        indexMatch[0][candidate] <== 0;
    }
    for (var step = 0; step < 5; step++) {
        var active = 1 << step;
        for (var candidate = 0; candidate < 32; candidate++) {
            if (candidate < active) {
                indexMatch[step + 1][candidate + active]
                    <== indexMatch[step][candidate] * indexBits[0].out[step];
                indexMatch[step + 1][candidate]
                    <== indexMatch[step][candidate]
                    - indexMatch[step + 1][candidate + active];
            } else if (candidate >= 2 * active) {
                indexMatch[step + 1][candidate] <== 0;
            }
        }
    }

    signal signDifference[31];
    var selectedSignValue = valueBits[1].out[127];
    for (var byte = 0; byte < 31; byte++) {
        if (byte < 16) {
            signDifference[byte] <== indexMatch[5][byte]
                * (valueBits[0].out[8 * byte + 7] - valueBits[1].out[127]);
        } else {
            signDifference[byte] <== indexMatch[5][byte]
                * (valueBits[1].out[8 * (byte - 16) + 7] - valueBits[1].out[127]);
        }
        selectedSignValue += signDifference[byte];
    }
    signal selectedSign <== selectedSignValue;

    signal originalByte[32];
    signal resultByte[32];
    signal fillActive[31];
    var lowerIndexSum = 0;
    var low = 0;
    var high = 0;
    for (var byte = 0; byte < 32; byte++) {
        var byteValue = 0;
        for (var bit = 0; bit < 8; bit++) {
            if (byte < 16) {
                byteValue += valueBits[0].out[8 * byte + bit] * (1 << bit);
            } else {
                byteValue += valueBits[1].out[8 * (byte - 16) + bit] * (1 << bit);
            }
        }
        originalByte[byte] <== byteValue;

        if (byte == 0) {
            resultByte[byte] <== originalByte[byte];
        } else {
            lowerIndexSum += indexMatch[5][byte - 1];
            fillActive[byte - 1] <== inRange * lowerIndexSum;
            resultByte[byte] <== originalByte[byte]
                + fillActive[byte - 1] * (255 * selectedSign - originalByte[byte]);
        }

        if (byte < 16) {
            low += resultByte[byte] * (1 << (8 * byte));
        } else {
            high += resultByte[byte] * (1 << (8 * (byte - 16)));
        }
    }

    out[0] <== low;
    out[1] <== high;
}
