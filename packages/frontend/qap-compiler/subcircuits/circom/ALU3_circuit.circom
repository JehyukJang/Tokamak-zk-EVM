pragma circom 2.1.6;

include "../../templates/256bit/alu_safe.circom";

template ALU3_() {
    var NUM_OPERATIONS = 5;
    var SELECTORS[NUM_OPERATIONS] = [
        1 << 11,
        1 << 22,
        1 << 23,
        1 << 24,
        1 << 26
    ];

    signal input in[5];
    signal output out[2];
    signal indexOrLhs[2] <== [in[1], in[2]];
    signal valueOrRhs[2] <== [in[3], in[4]];

    component lhsBits[2];
    component rhsBits[2];
    for (var limb = 0; limb < 2; limb++) {
        lhsBits[limb] = Num2Bits(128);
        rhsBits[limb] = Num2Bits(128);
        lhsBits[limb].in <== indexOrLhs[limb];
        rhsBits[limb].in <== valueOrRhs[limb];
    }

    var oversizedIndexSum = 0;
    for (var bit = 5; bit < 128; bit++) {
        oversizedIndexSum += lhsBits[0].out[bit];
    }
    for (var bit = 0; bit < 128; bit++) {
        oversizedIndexSum += lhsBits[1].out[bit];
    }
    signal indexInRange <== IsZero()(oversizedIndexSum);

    signal selectedByte[6][32];
    for (var byte = 0; byte < 32; byte++) {
        var sourceByte = 31 - byte;
        var byteValue = 0;
        for (var bit = 0; bit < 8; bit++) {
            if (sourceByte < 16) {
                byteValue += rhsBits[0].out[8 * sourceByte + bit] * (1 << bit);
            } else {
                byteValue += rhsBits[1].out[8 * (sourceByte - 16) + bit] * (1 << bit);
            }
        }
        selectedByte[0][byte] <== byteValue;
    }
    for (var step = 0; step < 5; step++) {
        var active = 32 \ (1 << (step + 1));
        for (var candidate = 0; candidate < 32; candidate++) {
            if (candidate < active) {
                selectedByte[step + 1][candidate]
                    <== selectedByte[step][2 * candidate]
                    + lhsBits[0].out[step]
                    * (selectedByte[step][2 * candidate + 1]
                        - selectedByte[step][2 * candidate]);
            } else {
                selectedByte[step + 1][candidate] <== 0;
            }
        }
    }
    signal byteResult[2] <== [
        indexInRange * selectedByte[5][0],
        0
    ];

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
                    <== indexMatch[step][candidate] * lhsBits[0].out[step];
                indexMatch[step + 1][candidate]
                    <== indexMatch[step][candidate]
                    - indexMatch[step + 1][candidate + active];
            } else if (candidate >= 2 * active) {
                indexMatch[step + 1][candidate] <== 0;
            }
        }
    }

    signal signDifference[31];
    var selectedSignValue = rhsBits[1].out[127];
    for (var byte = 0; byte < 31; byte++) {
        if (byte < 16) {
            signDifference[byte] <== indexMatch[5][byte]
                * (rhsBits[0].out[8 * byte + 7] - rhsBits[1].out[127]);
        } else {
            signDifference[byte] <== indexMatch[5][byte]
                * (rhsBits[1].out[8 * (byte - 16) + 7] - rhsBits[1].out[127]);
        }
        selectedSignValue += signDifference[byte];
    }
    signal selectedSign <== selectedSignValue;

    signal originalByte[32];
    signal signExtendedByte[32];
    signal fillActive[31];
    var lowerIndexSum = 0;
    var signExtendedLow = 0;
    var signExtendedHigh = 0;
    for (var byte = 0; byte < 32; byte++) {
        var byteValue = 0;
        for (var bit = 0; bit < 8; bit++) {
            if (byte < 16) {
                byteValue += rhsBits[0].out[8 * byte + bit] * (1 << bit);
            } else {
                byteValue += rhsBits[1].out[8 * (byte - 16) + bit] * (1 << bit);
            }
        }
        originalByte[byte] <== byteValue;

        if (byte == 0) {
            signExtendedByte[byte] <== originalByte[byte];
        } else {
            lowerIndexSum += indexMatch[5][byte - 1];
            fillActive[byte - 1] <== indexInRange * lowerIndexSum;
            signExtendedByte[byte] <== originalByte[byte]
                + fillActive[byte - 1]
                * (255 * selectedSign - originalByte[byte]);
        }

        if (byte < 16) {
            signExtendedLow += signExtendedByte[byte] * (1 << (8 * byte));
        } else {
            signExtendedHigh += signExtendedByte[byte] * (1 << (8 * (byte - 16)));
        }
    }
    signal signExtendResult[2] <== [signExtendedLow, signExtendedHigh];

    signal andResult[2];
    signal orResult[2];
    signal xorResult[2];
    signal bitProduct[2][128];
    for (var limb = 0; limb < 2; limb++) {
        var andLimb = 0;
        var orLimb = 0;
        var xorLimb = 0;
        for (var bit = 0; bit < 128; bit++) {
            bitProduct[limb][bit]
                <== lhsBits[limb].out[bit] * rhsBits[limb].out[bit];
            andLimb += bitProduct[limb][bit] * (1 << bit);
            orLimb += (
                lhsBits[limb].out[bit]
                + rhsBits[limb].out[bit]
                - bitProduct[limb][bit]
            ) * (1 << bit);
            xorLimb += (
                lhsBits[limb].out[bit]
                + rhsBits[limb].out[bit]
                - 2 * bitProduct[limb][bit]
            ) * (1 << bit);
        }
        andResult[limb] <== andLimb;
        orResult[limb] <== orLimb;
        xorResult[limb] <== xorLimb;
    }

    component selectorMatches[NUM_OPERATIONS];
    signal selectorFlags[NUM_OPERATIONS];
    for (var operation = 0; operation < NUM_OPERATIONS; operation++) {
        selectorMatches[operation] = IsEqual();
        selectorMatches[operation].in[0] <== in[0];
        selectorMatches[operation].in[1] <== SELECTORS[operation];
        selectorFlags[operation] <== selectorMatches[operation].out;
    }
    selectorFlags[0]
        + selectorFlags[1]
        + selectorFlags[2]
        + selectorFlags[3]
        + selectorFlags[4]
        === 1;

    signal operationResults[NUM_OPERATIONS][2];
    operationResults[0] <== signExtendResult;
    operationResults[1] <== andResult;
    operationResults[2] <== orResult;
    operationResults[3] <== xorResult;
    operationResults[4] <== byteResult;

    component resultMux = ComplexMux256_checked(NUM_OPERATIONS);
    resultMux.selector <== selectorFlags;
    resultMux.ins <== operationResults;
    out <== resultMux.out;
}

component main {public [in]} = ALU3_();
