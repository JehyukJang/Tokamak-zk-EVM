pragma circom 2.1.6;

include "circomlib/circuits/bitify.circom";
include "../../functions/arithmetic.circom";
include "mux.circom";

// Subtracts canonical 256-bit words modulo 2^256.
template Sub256Sound() {
    var BASE128 = 1 << 128;

    signal input in1[2], in2[2];
    signal output out[2];

    out <-- _sub256(in1, in2);
    component outBits[2];
    for (var limb = 0; limb < 2; limb++) {
        outBits[limb] = Num2Bits(128);
        outBits[limb].in <== out[limb];
    }

    signal borrowLow <-- in1[0] < in2[0];
    signal borrowHigh <-- in1[1] < in2[1] + borrowLow;
    borrowLow * (borrowLow - 1) === 0;
    borrowHigh * (borrowHigh - 1) === 0;
    in1[0] + borrowLow * BASE128 === in2[0] + out[0];
    in1[1] + borrowHigh * BASE128 === in2[1] + borrowLow + out[1];
}

template SignAndAbs256Sound() {
    signal input in[2];
    signal output isNegative, absolute[2];

    component inputBits[2];
    for (var limb = 0; limb < 2; limb++) {
        inputBits[limb] = Num2Bits(128);
        inputBits[limb].in <== in[limb];
    }
    isNegative <== inputBits[1].out[127];

    signal negated[2] <== Sub256Sound()([0, 0], in);
    absolute <== Mux256()(isNegative, negated, in);
}

template RecoverSigned256Sound() {
    signal input isNegative, absolute[2];
    signal output out[2];

    isNegative * (isNegative - 1) === 0;
    component absoluteBits[2];
    for (var limb = 0; limb < 2; limb++) {
        absoluteBits[limb] = Num2Bits(128);
        absoluteBits[limb].in <== absolute[limb];
    }
    signal negated[2] <== Sub256Sound()([0, 0], absolute);
    out <== Mux256()(isNegative, negated, absolute);
}

// Multiplies canonical 256-bit words and returns the product modulo 2^256.
// Each word uses two little-endian 128-bit limbs.
template Mul256TruncatedSound() {
    var BASE64 = 1 << 64;
    var BASE128 = 1 << 128;

    signal input in1[2], in2[2];
    signal output out[2];

    component in1Bits[2];
    component in2Bits[2];
    for (var limb = 0; limb < 2; limb++) {
        in1Bits[limb] = Num2Bits(128);
        in2Bits[limb] = Num2Bits(128);
        in1Bits[limb].in <== in1[limb];
        in2Bits[limb].in <== in2[limb];
    }

    signal a[4];
    signal b[4];
    for (var word = 0; word < 2; word++) {
        var aLow = 0;
        var aHigh = 0;
        var bLow = 0;
        var bHigh = 0;
        for (var bit = 0; bit < 64; bit++) {
            aLow += in1Bits[word].out[bit] * (1 << bit);
            aHigh += in1Bits[word].out[bit + 64] * (1 << bit);
            bLow += in2Bits[word].out[bit] * (1 << bit);
            bHigh += in2Bits[word].out[bit + 64] * (1 << bit);
        }
        a[2 * word] <== aLow;
        a[2 * word + 1] <== aHigh;
        b[2 * word] <== bLow;
        b[2 * word + 1] <== bHigh;
    }

    signal product[4][4];
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 4; j++) {
            if (i + j < 4) {
                product[i][j] <== a[i] * b[j];
            } else {
                product[i][j] <== 0;
            }
        }
    }

    // Each coefficient contains at most four products below 2^128. Therefore
    // every raw block is below 2^194 and cannot wrap in the scalar field.
    signal rawLow <== product[0][0] + BASE64 * (product[0][1] + product[1][0]);
    signal carryLow <-- rawLow \ BASE128;
    out[0] <-- rawLow % BASE128;
    signal carryLowBits[65] <== Num2Bits(65)(carryLow);
    rawLow === out[0] + carryLow * BASE128;

    signal rawHigh <== carryLow
        + product[0][2] + product[1][1] + product[2][0]
        + BASE64 * (product[0][3] + product[1][2] + product[2][1] + product[3][0]);
    signal carryHigh <-- rawHigh \ BASE128;
    out[1] <-- rawHigh % BASE128;
    signal carryHighBits[66] <== Num2Bits(66)(carryHigh);
    rawHigh === out[1] + carryHigh * BASE128;

    component outBits[2];
    for (var limb = 0; limb < 2; limb++) {
        outBits[limb] = Num2Bits(128);
        outBits[limb].in <== out[limb];
    }
}

// Multiplies canonical 256-bit words and returns the full 512-bit product.
// The four output limbs are little-endian 128-bit limbs.
template Mul256FullSound() {
    var BASE64 = 1 << 64;
    var BASE128 = 1 << 128;

    signal input in1[2], in2[2];
    signal output out[4];

    component in1Bits[2];
    component in2Bits[2];
    for (var limb = 0; limb < 2; limb++) {
        in1Bits[limb] = Num2Bits(128);
        in2Bits[limb] = Num2Bits(128);
        in1Bits[limb].in <== in1[limb];
        in2Bits[limb].in <== in2[limb];
    }

    signal a[4];
    signal b[4];
    for (var word = 0; word < 2; word++) {
        var aLow = 0;
        var aHigh = 0;
        var bLow = 0;
        var bHigh = 0;
        for (var bit = 0; bit < 64; bit++) {
            aLow += in1Bits[word].out[bit] * (1 << bit);
            aHigh += in1Bits[word].out[bit + 64] * (1 << bit);
            bLow += in2Bits[word].out[bit] * (1 << bit);
            bHigh += in2Bits[word].out[bit + 64] * (1 << bit);
        }
        a[2 * word] <== aLow;
        a[2 * word + 1] <== aHigh;
        b[2 * word] <== bLow;
        b[2 * word + 1] <== bHigh;
    }

    signal product[4][4];
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 4; j++) {
            product[i][j] <== a[i] * b[j];
        }
    }

    // Each coefficient contains at most four products below 2^128. Therefore
    // every raw block is below 2^194 and cannot wrap in the scalar field.
    signal raw0 <== product[0][0] + BASE64 * (product[0][1] + product[1][0]);
    signal carry0 <-- raw0 \ BASE128;
    out[0] <-- raw0 % BASE128;
    signal carry0Bits[65] <== Num2Bits(65)(carry0);
    raw0 === out[0] + carry0 * BASE128;

    signal raw1 <== carry0
        + product[0][2] + product[1][1] + product[2][0]
        + BASE64 * (product[0][3] + product[1][2] + product[2][1] + product[3][0]);
    signal carry1 <-- raw1 \ BASE128;
    out[1] <-- raw1 % BASE128;
    signal carry1Bits[66] <== Num2Bits(66)(carry1);
    raw1 === out[1] + carry1 * BASE128;

    signal raw2 <== carry1
        + product[1][3] + product[2][2] + product[3][1]
        + BASE64 * (product[2][3] + product[3][2]);
    signal carry2 <-- raw2 \ BASE128;
    out[2] <-- raw2 % BASE128;
    signal carry2Bits[66] <== Num2Bits(66)(carry2);
    raw2 === out[2] + carry2 * BASE128;

    signal raw3 <== carry2 + product[3][3];
    out[3] <== raw3;

    component outBits[4];
    for (var outLimb = 0; outLimb < 4; outLimb++) {
        outBits[outLimb] = Num2Bits(128);
        outBits[outLimb].in <== out[outLimb];
    }
}

// Multiplies a canonical 512-bit word by a canonical 256-bit word.
// Inputs and the full 768-bit output use little-endian 128-bit limbs.
template Mul512By256FullSound() {
    var BASE64 = 1 << 64;
    var BASE128 = 1 << 128;

    signal input in1[4], in2[2];
    signal output out[6];

    component in1Bits[4];
    component in2Bits[2];
    for (var limb = 0; limb < 4; limb++) {
        in1Bits[limb] = Num2Bits(128);
        in1Bits[limb].in <== in1[limb];
    }
    for (var limb = 0; limb < 2; limb++) {
        in2Bits[limb] = Num2Bits(128);
        in2Bits[limb].in <== in2[limb];
    }

    signal a[8];
    signal b[4];
    for (var word = 0; word < 4; word++) {
        var low = 0;
        var high = 0;
        for (var bit = 0; bit < 64; bit++) {
            low += in1Bits[word].out[bit] * (1 << bit);
            high += in1Bits[word].out[bit + 64] * (1 << bit);
        }
        a[2 * word] <== low;
        a[2 * word + 1] <== high;
    }
    for (var word = 0; word < 2; word++) {
        var low = 0;
        var high = 0;
        for (var bit = 0; bit < 64; bit++) {
            low += in2Bits[word].out[bit] * (1 << bit);
            high += in2Bits[word].out[bit + 64] * (1 << bit);
        }
        b[2 * word] <== low;
        b[2 * word + 1] <== high;
    }

    signal product[8][4];
    for (var i = 0; i < 8; i++) {
        for (var j = 0; j < 4; j++) {
            product[i][j] <== a[i] * b[j];
        }
    }

    // The 256-bit operand limits every coefficient to four products below
    // 2^128. Each raw block is consequently below 2^194 and field-safe.
    signal carry[6];
    signal raw[5];
    signal carryBits[5][66];
    carry[0] <== 0;
    for (var block = 0; block < 5; block++) {
        var evenCoefficient = 0;
        var oddCoefficient = 0;
        for (var i = 0; i < 8; i++) {
            for (var j = 0; j < 4; j++) {
                if (i + j == 2 * block) {
                    evenCoefficient += product[i][j];
                }
                if (i + j == 2 * block + 1) {
                    oddCoefficient += product[i][j];
                }
            }
        }
        raw[block] <== carry[block] + evenCoefficient + BASE64 * oddCoefficient;
        carry[block + 1] <-- raw[block] \ BASE128;
        out[block] <-- raw[block] % BASE128;
        carryBits[block] <== Num2Bits(66)(carry[block + 1]);
        raw[block] === out[block] + carry[block + 1] * BASE128;
    }

    var finalCoefficient = 0;
    for (var i = 0; i < 8; i++) {
        for (var j = 0; j < 4; j++) {
            if (i + j == 10) {
                finalCoefficient += product[i][j];
            }
        }
    }
    out[5] <== carry[5] + finalCoefficient;

    component outBits[6];
    for (var outLimb = 0; outLimb < 6; outLimb++) {
        outBits[outLimb] = Num2Bits(128);
        outBits[outLimb].in <== out[outLimb];
    }
}
