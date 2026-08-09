pragma circom 2.1.6;
include "arithmetic_unsafe_type1.circom";

// Performs one LSB-first square-and-multiply step. The input state is
// canonicalized locally. The exact next SubExp placement canonicalizes both
// outputs; the terminal accumulator is canonicalized by CheckBus256.
template SubExp() {
    signal input in[5];
    signal output out[4];

    component accumulatorSplit[2];
    component basePowerSplit[2];
    signal accumulatorWords[4];
    signal basePowerWords[4];
    for (var limb = 0; limb < 2; limb++) {
        accumulatorSplit[limb] = Split128To64();
        basePowerSplit[limb] = Split128To64();
        accumulatorSplit[limb].in <== in[limb];
        basePowerSplit[limb].in <== in[2 + limb];
        accumulatorWords[2 * limb] <== accumulatorSplit[limb].words[0];
        accumulatorWords[2 * limb + 1] <== accumulatorSplit[limb].words[1];
        basePowerWords[2 * limb] <== basePowerSplit[limb].words[0];
        basePowerWords[2 * limb + 1] <== basePowerSplit[limb].words[1];
    }

    // The EXP composition connects this input to the corresponding DecToBit
    // output, so Booleanity is owned by that exact producer.
    signal factorWords[4];
    factorWords[0] <== 1 - in[4] + in[4] * basePowerWords[0];
    for (var word = 1; word < 4; word++) {
        factorWords[word] <== in[4] * basePowerWords[word];
    }

    component square = Square256TruncatedFrom64_unsafe();
    square.in <== basePowerWords;

    component accumulate = Mul256TruncatedFrom64_unsafe();
    accumulate.in1 <== accumulatorWords;
    accumulate.in2 <== factorWords;

    out <== [
        accumulate.out[0],
        accumulate.out[1],
        square.out[0],
        square.out[1]
    ];
}
