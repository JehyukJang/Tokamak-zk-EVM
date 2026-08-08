pragma circom 2.1.6;
include "../../templates/256bit/arithmetic_unsafe_type1.circom";
include "./constants.circom";

template SubExpBatch(N) {
    signal input in[4 + N];
    signal output out[4];

    component accumulatorEntrySplit[2];
    component basePowerEntrySplit[2];
    signal accumulatorWords[N + 1][4];
    signal basePowerWords[N + 1][4];
    for (var limb = 0; limb < 2; limb++) {
        accumulatorEntrySplit[limb] = Split128To64();
        basePowerEntrySplit[limb] = Split128To64();
        accumulatorEntrySplit[limb].in <== in[limb];
        basePowerEntrySplit[limb].in <== in[2 + limb];
        accumulatorWords[0][2 * limb]
            <== accumulatorEntrySplit[limb].words[0];
        accumulatorWords[0][2 * limb + 1]
            <== accumulatorEntrySplit[limb].words[1];
        basePowerWords[0][2 * limb]
            <== basePowerEntrySplit[limb].words[0];
        basePowerWords[0][2 * limb + 1]
            <== basePowerEntrySplit[limb].words[1];
    }

    component square[N];
    component accumulate[N];
    component accumulatorLowSplit[N];
    component accumulatorHighSplit[N];
    component basePowerLowSplit[N];
    component basePowerHighSplit[N];
    signal bits[N];
    signal factorWords[N][4];
    for (var step = 0; step < N; step++) {
        // The EXP composition connects these inputs to DecToBit outputs.
        bits[step] <== in[4 + step];

        factorWords[step][0]
            <== 1 - bits[step]
            + bits[step] * basePowerWords[step][0];
        for (var word = 1; word < 4; word++) {
            factorWords[step][word]
                <== bits[step] * basePowerWords[step][word];
        }

        square[step] = Square256TruncatedFrom64_unsafe();
        square[step].in <== basePowerWords[step];

        accumulate[step] = Mul256TruncatedFrom64_unsafe();
        accumulate[step].in1 <== accumulatorWords[step];
        accumulate[step].in2 <== factorWords[step];

        accumulatorLowSplit[step] = Split128To64();
        accumulatorHighSplit[step] = Split128To64();
        accumulatorLowSplit[step].in <== accumulate[step].out[0];
        accumulatorHighSplit[step].in <== accumulate[step].out[1];
        accumulatorWords[step + 1] <== [
            accumulatorLowSplit[step].words[0],
            accumulatorLowSplit[step].words[1],
            accumulatorHighSplit[step].words[0],
            accumulatorHighSplit[step].words[1]
        ];

        basePowerLowSplit[step] = Split128To64();
        basePowerHighSplit[step] = Split128To64();
        basePowerLowSplit[step].in <== square[step].out[0];
        basePowerHighSplit[step].in <== square[step].out[1];
        basePowerWords[step + 1] <== [
            basePowerLowSplit[step].words[0],
            basePowerLowSplit[step].words[1],
            basePowerHighSplit[step].words[0],
            basePowerHighSplit[step].words[1]
        ];
    }

    out <== [
        accumulatorWords[N][0] + (1 << 64) * accumulatorWords[N][1],
        accumulatorWords[N][2] + (1 << 64) * accumulatorWords[N][3],
        basePowerWords[N][0] + (1 << 64) * basePowerWords[N][1],
        basePowerWords[N][2] + (1 << 64) * basePowerWords[N][3]
    ];
}

component main {public [in]} = SubExpBatch(nSubExpBatch());
