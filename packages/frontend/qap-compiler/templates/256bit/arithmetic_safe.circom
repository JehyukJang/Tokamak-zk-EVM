pragma circom 2.1.6;
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/gates.circom";
include "../128bit/arithmetic.circom";
include "mux.circom";
include "compare_safe.circom";
include "../../functions/arithmetic.circom";

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

template DivMod256() {
    var BASE64 = 1 << 64;
    var BASE128 = 1 << 128;

    signal input dividend[2], divisor[2];
    signal output quotient[2], remainder[2];

    component divisorBits[2];
    component dividendBits[2];
    component quotientBits[2];
    component remainderBits[2];
    signal divisorWords[4];
    signal quotientWords[4];
    var divisorBitSum = 0;
    for (var limb = 0; limb < 2; limb++) {
        divisorBits[limb] = Num2Bits(128);
        dividendBits[limb] = Num2Bits(128);
        divisorBits[limb].in <== divisor[limb];
        dividendBits[limb].in <== dividend[limb];

        var divisorLow = 0;
        var divisorHigh = 0;
        for (var bit = 0; bit < 64; bit++) {
            divisorLow += divisorBits[limb].out[bit] * (1 << bit);
            divisorHigh += divisorBits[limb].out[bit + 64] * (1 << bit);
            divisorBitSum += divisorBits[limb].out[bit]
                + divisorBits[limb].out[bit + 64];
        }
        divisorWords[2 * limb] <== divisorLow;
        divisorWords[2 * limb + 1] <== divisorHigh;
    }

    signal divisorIsZero <== IsZero()(divisorBitSum);
    signal safeDivisor[2] <== [divisor[0] + divisorIsZero, divisor[1]];
    signal safeDivisorWords[4] <== [
        divisorWords[0] + divisorIsZero,
        divisorWords[1],
        divisorWords[2],
        divisorWords[3]
    ];

    var division[2][2] = _div256(dividend, safeDivisor);
    signal relationQuotient[2] <-- division[0];
    signal relationRemainder[2] <-- division[1];

    for (var limb = 0; limb < 2; limb++) {
        quotientBits[limb] = Num2Bits(128);
        remainderBits[limb] = Num2Bits(128);
        quotientBits[limb].in <== relationQuotient[limb];
        remainderBits[limb].in <== relationRemainder[limb];

        var quotientLow = 0;
        var quotientHigh = 0;
        for (var bit = 0; bit < 64; bit++) {
            quotientLow += quotientBits[limb].out[bit] * (1 << bit);
            quotientHigh += quotientBits[limb].out[bit + 64] * (1 << bit);
        }
        quotientWords[2 * limb] <== quotientLow;
        quotientWords[2 * limb + 1] <== quotientHigh;
    }

    signal products[4][4];
    for (var quotientWord = 0; quotientWord < 4; quotientWord++) {
        for (var divisorWord = 0; divisorWord < 4; divisorWord++) {
            products[quotientWord][divisorWord]
                <== quotientWords[quotientWord] * safeDivisorWords[divisorWord];
        }
    }

    signal coefficient[7];
    for (var degree = 0; degree < 7; degree++) {
        var coefficientSum = 0;
        for (var quotientWord = 0; quotientWord < 4; quotientWord++) {
            var divisorWord = degree - quotientWord;
            if (divisorWord >= 0 && divisorWord < 4) {
                coefficientSum += products[quotientWord][divisorWord];
            }
        }
        coefficient[degree] <== coefficientSum;
    }

    signal carry[2];
    carry[0] <-- (
        coefficient[0]
        + BASE64 * coefficient[1]
        + relationRemainder[0]
    ) \ BASE128;
    carry[1] <-- (
        coefficient[2]
        + BASE64 * coefficient[3]
        + relationRemainder[1]
        + carry[0]
    ) \ BASE128;
    component carryLowBits = Num2Bits(65);
    component carryMiddleBits = Num2Bits(66);
    carryLowBits.in <== carry[0];
    carryMiddleBits.in <== carry[1];

    coefficient[0]
        + BASE64 * coefficient[1]
        + relationRemainder[0]
        === dividend[0] + BASE128 * carry[0];
    coefficient[2]
        + BASE64 * coefficient[3]
        + relationRemainder[1]
        + carry[0]
        === dividend[1] + BASE128 * carry[1];
    coefficient[4]
        + BASE64 * coefficient[5]
        + carry[1]
        === 0;
    coefficient[6] === 0;

    signal remainderLowerLess
        <== LessThan(128)([relationRemainder[0], safeDivisor[0]]);
    signal remainderUpperLess
        <== LessThan(128)([relationRemainder[1], safeDivisor[1]]);
    signal remainderUpperEqual
        <== IsEqual()([relationRemainder[1], safeDivisor[1]]);
    signal remainderInRange
        <== remainderUpperLess
        + remainderUpperEqual * remainderLowerLess;
    remainderInRange === 1;

    for (var limb = 0; limb < 2; limb++) {
        quotient[limb]
            <== (1 - divisorIsZero) * relationQuotient[limb];
        remainder[limb] <== relationRemainder[limb];
    }
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

// Every input must be connected to a locally constrained bit decomposition.
template ShiftLeft256FromBits_unsafe() {
    signal input shiftLowBits[128], shiftHighContribution, valueBits[2][128];
    signal output out[2], outBits[2][128], inRange;

    signal valueWords[4];
    for (var limb = 0; limb < 2; limb++) {
        var lowWord = 0;
        var highWord = 0;
        for (var bit = 0; bit < 64; bit++) {
            lowWord += valueBits[limb][bit] * (1 << bit);
            highWord += valueBits[limb][bit + 64] * (1 << bit);
        }
        valueWords[2 * limb] <== lowWord;
        valueWords[2 * limb + 1] <== highWord;
    }

    var oversizedSum = shiftHighContribution;
    for (var bit = 8; bit < 128; bit++) {
        oversizedSum += shiftLowBits[bit];
    }
    inRange <== IsZero()(oversizedSum);

    signal wordPower[7];
    wordPower[0] <== 1;
    for (var bit = 0; bit < 6; bit++) {
        var selectedFactor = (1 << (1 << bit)) - 1;
        wordPower[bit + 1] <== wordPower[bit]
            * (1 + shiftLowBits[bit] * selectedFactor);
    }

    signal shiftWords[4];
    signal lowPair <== wordPower[6] * (1 - shiftLowBits[7]);
    signal highPair <== wordPower[6] - lowPair;
    shiftWords[1] <== lowPair * shiftLowBits[6];
    shiftWords[0] <== lowPair - shiftWords[1];
    shiftWords[3] <== highPair * shiftLowBits[6];
    shiftWords[2] <== highPair - shiftWords[3];

    component shifted = Mul256TruncatedFrom64_unsafe();
    shifted.in1 <== valueWords;
    shifted.in2 <== shiftWords;
    out[0] <== inRange * shifted.out[0];
    out[1] <== inRange * shifted.out[1];
    component canonicalOutput[2];
    for (var limb = 0; limb < 2; limb++) {
        canonicalOutput[limb] = Num2Bits(128);
        canonicalOutput[limb].in <== out[limb];
        for (var bit = 0; bit < 128; bit++) {
            outBits[limb][bit] <== canonicalOutput[limb].out[bit];
        }
    }
}

template ShiftLeft256() {
    signal input shift[2], value[2];
    signal output out[2];

    component shiftLowBits = Num2Bits(128);
    component shiftHighIsZero = IsZero();
    component valueBits[2];
    component core = ShiftLeft256FromBits_unsafe();
    shiftLowBits.in <== shift[0];
    shiftHighIsZero.in <== shift[1];
    core.shiftHighContribution <== 1 - shiftHighIsZero.out;
    for (var bit = 0; bit < 128; bit++) {
        core.shiftLowBits[bit] <== shiftLowBits.out[bit];
    }
    for (var limb = 0; limb < 2; limb++) {
        valueBits[limb] = Num2Bits(128);
        valueBits[limb].in <== value[limb];
        for (var bit = 0; bit < 128; bit++) {
            core.valueBits[limb][bit] <== valueBits[limb].out[bit];
        }
    }
    out <== core.out;
}

template ShiftRight256() {
    signal input shift[2], value[2];
    signal output out[2], inRange, valueSign, shiftLowBits[8];

    component shiftBits[2];
    component valueBits[2];
    component core = ShiftLeft256FromBits_unsafe();
    for (var limb = 0; limb < 2; limb++) {
        shiftBits[limb] = Num2Bits(128);
        valueBits[limb] = Num2Bits(128);
        shiftBits[limb].in <== shift[limb];
        valueBits[limb].in <== value[limb];
    }
    var shiftHighContribution = 0;
    for (var bit = 0; bit < 128; bit++) {
        shiftHighContribution += shiftBits[1].out[bit];
        core.shiftLowBits[bit] <== shiftBits[0].out[bit];
    }
    core.shiftHighContribution <== shiftHighContribution;
    for (var limb = 0; limb < 2; limb++) {
        for (var bit = 0; bit < 128; bit++) {
            var reversed = 255 - (128 * limb + bit);
            var reversedLimb = reversed \ 128;
            var reversedBit = reversed % 128;
            core.valueBits[limb][bit]
                <== valueBits[reversedLimb].out[reversedBit];
        }
    }

    for (var limb = 0; limb < 2; limb++) {
        var result = 0;
        for (var bit = 0; bit < 128; bit++) {
            var reversed = 255 - (128 * limb + bit);
            var reversedLimb = reversed \ 128;
            var reversedBit = reversed % 128;
            result += core.outBits[reversedLimb][reversedBit] * (1 << bit);
        }
        out[limb] <== result;
    }
    inRange <== core.inRange;
    valueSign <== valueBits[1].out[127];
    for (var bit = 0; bit < 8; bit++) {
        shiftLowBits[bit] <== shiftBits[0].out[bit];
    }
}

// The input bits must come from a constrained decomposition. For a nonzero
// shift byte, negativeFiller is 2^256 - 2^(256 - shift). A zero shift produces
// a zero filler.
template InverseShiftPower256FromBits_unsafe() {
    var BASE64 = 1 << 64;
    var BASE128 = 1 << 128;

    signal input shiftBits[8];
    signal output negativeFiller[2];

    signal borrow[9];
    signal borrowedBit[8];
    signal shiftMinusOneBits[8];
    signal inverseBits[8];
    borrow[0] <== 1;
    for (var bit = 0; bit < 8; bit++) {
        borrowedBit[bit] <== shiftBits[bit] * borrow[bit];
        shiftMinusOneBits[bit]
            <== shiftBits[bit] + borrow[bit] - 2 * borrowedBit[bit];
        borrow[bit + 1] <== borrow[bit] - borrowedBit[bit];
        inverseBits[bit] <== 1 - shiftMinusOneBits[bit];
    }

    signal wordPower[7];
    wordPower[0] <== 1;
    for (var bit = 0; bit < 6; bit++) {
        var selectedFactor = (1 << (1 << bit)) - 1;
        wordPower[bit + 1] <== wordPower[bit]
            * (1 + inverseBits[bit] * selectedFactor);
    }

    signal powerWords[4];
    signal lowPair <== wordPower[6] * (1 - inverseBits[7]);
    signal highPair <== wordPower[6] - lowPair;
    powerWords[1] <== lowPair * inverseBits[6];
    powerWords[0] <== lowPair - powerWords[1] - borrow[8];
    powerWords[3] <== highPair * inverseBits[6];
    powerWords[2] <== highPair - powerWords[3];

    signal power[2];
    power[0] <== powerWords[0] + BASE64 * powerWords[1];
    power[1] <== powerWords[2] + BASE64 * powerWords[3];

    signal lowPower <== 1 - borrow[8] - inverseBits[7];
    negativeFiller[0] <== lowPower * BASE128 - power[0];
    negativeFiller[1] <== lowPower * (BASE128 - 1)
        + inverseBits[7] * BASE128 - power[1];
}
