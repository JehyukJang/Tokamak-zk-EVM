pragma circom 2.1.6;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/gates.circom";

// DIRECTION: 0 for left, 1 for right. SIGNED is used only for right shift.
template FullDomainShiftSound(DIRECTION, SIGNED) {
    signal input shift[2], value[2];
    signal output out[2];

    component shiftBits[2];
    component valueBits[2];
    for (var limb = 0; limb < 2; limb++) {
        shiftBits[limb] = Num2Bits(128);
        valueBits[limb] = Num2Bits(128);
        shiftBits[limb].in <== shift[limb];
        valueBits[limb].in <== value[limb];
    }

    var oversizedSum = 0;
    for (var bit = 8; bit < 128; bit++) {
        oversizedSum += shiftBits[0].out[bit];
    }
    for (var bit = 0; bit < 128; bit++) {
        oversizedSum += shiftBits[1].out[bit];
    }
    signal isSmall <== IsZero()(oversizedSum);
    signal sign <== valueBits[1].out[127];

    signal stage[9][256];
    for (var bit = 0; bit < 256; bit++) {
        if (bit < 128) {
            stage[0][bit] <== valueBits[0].out[bit];
        } else {
            stage[0][bit] <== valueBits[1].out[bit - 128];
        }
    }

    for (var step = 0; step < 8; step++) {
        var distance = 1 << step;
        for (var bit = 0; bit < 256; bit++) {
            if (DIRECTION == 0) {
                if (bit >= distance) {
                    stage[step + 1][bit] <== stage[step][bit]
                        + shiftBits[0].out[step] * (stage[step][bit - distance] - stage[step][bit]);
                } else {
                    stage[step + 1][bit] <== (1 - shiftBits[0].out[step]) * stage[step][bit];
                }
            } else {
                if (bit + distance < 256) {
                    stage[step + 1][bit] <== stage[step][bit]
                        + shiftBits[0].out[step] * (stage[step][bit + distance] - stage[step][bit]);
                } else if (SIGNED == 1) {
                    stage[step + 1][bit] <== stage[step][bit]
                        + shiftBits[0].out[step] * (sign - stage[step][bit]);
                } else {
                    stage[step + 1][bit] <== (1 - shiftBits[0].out[step]) * stage[step][bit];
                }
            }
        }
    }

    signal resultBits[256];
    for (var bit = 0; bit < 256; bit++) {
        if (SIGNED == 1) {
            resultBits[bit] <== sign + isSmall * (stage[8][bit] - sign);
        } else {
            resultBits[bit] <== isSmall * stage[8][bit];
        }
    }

    var low = 0;
    var high = 0;
    for (var bit = 0; bit < 128; bit++) {
        low += resultBits[bit] * (1 << bit);
        high += resultBits[bit + 128] * (1 << bit);
    }
    out[0] <== low;
    out[1] <== high;
}

template FullDomainByteSound() {
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
    signal isSmall <== IsZero()(oversizedSum);

    signal selected[6][32][8];
    for (var byte = 0; byte < 32; byte++) {
        var sourceByte = 31 - byte;
        for (var bit = 0; bit < 8; bit++) {
            if (sourceByte < 16) {
                selected[0][byte][bit] <== valueBits[0].out[8 * sourceByte + bit];
            } else {
                selected[0][byte][bit] <== valueBits[1].out[8 * (sourceByte - 16) + bit];
            }
        }
    }
    for (var step = 0; step < 5; step++) {
        var active = 32 \ (1 << (step + 1));
        for (var candidate = 0; candidate < 32; candidate++) {
            for (var bit = 0; bit < 8; bit++) {
                if (candidate < active) {
                    selected[step + 1][candidate][bit] <== selected[step][2 * candidate][bit]
                        + indexBits[0].out[step]
                        * (selected[step][2 * candidate + 1][bit] - selected[step][2 * candidate][bit]);
                } else {
                    selected[step + 1][candidate][bit] <== 0;
                }
            }
        }
    }

    signal resultBits[8];
    var result = 0;
    for (var bit = 0; bit < 8; bit++) {
        resultBits[bit] <== isSmall * selected[5][0][bit];
        result += resultBits[bit] * (1 << bit);
    }
    out[0] <== result;
    out[1] <== 0;
}

template FullDomainSignExtendSound() {
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
    signal isSmall <== IsZero()(oversizedSum);

    signal indexMatch[32][6];
    for (var byte = 0; byte < 32; byte++) {
        indexMatch[byte][0] <== 1;
        for (var bit = 0; bit < 5; bit++) {
            if ((byte \ (1 << bit)) % 2 == 1) {
                indexMatch[byte][bit + 1] <== indexMatch[byte][bit] * indexBits[0].out[bit];
            } else {
                indexMatch[byte][bit + 1] <== indexMatch[byte][bit] * (1 - indexBits[0].out[bit]);
            }
        }
    }

    signal signProduct[32];
    var selectedSignSum = 0;
    for (var byte = 0; byte < 32; byte++) {
        if (byte < 16) {
            signProduct[byte] <== indexMatch[byte][5] * valueBits[0].out[8 * byte + 7];
        } else {
            signProduct[byte] <== indexMatch[byte][5] * valueBits[1].out[8 * (byte - 16) + 7];
        }
        selectedSignSum += signProduct[byte];
    }
    signal selectedSign <== selectedSignSum;

    signal valueBit[256];
    signal extendedBit[256];
    signal resultBits[256];
    for (var bit = 0; bit < 256; bit++) {
        var byte = bit \ 8;
        var keepOriginal = 0;
        for (var candidateIndex = byte; candidateIndex < 32; candidateIndex++) {
            keepOriginal += indexMatch[candidateIndex][5];
        }
        if (bit < 128) {
            valueBit[bit] <== valueBits[0].out[bit];
        } else {
            valueBit[bit] <== valueBits[1].out[bit - 128];
        }
        extendedBit[bit] <== selectedSign + keepOriginal * (valueBit[bit] - selectedSign);
        resultBits[bit] <== valueBit[bit] + isSmall * (extendedBit[bit] - valueBit[bit]);
    }

    var low = 0;
    var high = 0;
    for (var bit = 0; bit < 128; bit++) {
        low += resultBits[bit] * (1 << bit);
        high += resultBits[bit + 128] * (1 << bit);
    }
    out[0] <== low;
    out[1] <== high;
}
