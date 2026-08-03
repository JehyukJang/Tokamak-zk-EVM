pragma circom 2.1.6;
include "../../templates/256bit/arithmetic_sound.circom";
include "./constants.circom";

template SubExpSound() {
    signal input cPrevious[2], aPrevious[2], exponentBit;
    signal output cNext[2], aNext[2];

    exponentBit * (exponentBit - 1) === 0;
    aNext <== Mul256TruncatedSound()(aPrevious, aPrevious);

    signal factor[2];
    factor[0] <== 1 - exponentBit + exponentBit * aPrevious[0];
    factor[1] <== exponentBit * aPrevious[1];
    cNext <== Mul256TruncatedSound()(cPrevious, factor);
}

template SubExpBatch(N) {
    signal input in[4 + N];
    signal output out[4];

    signal c[N + 1][2];
    signal a[N + 1][2];
    c[0] <== [in[0], in[1]];
    a[0] <== [in[2], in[3]];
    component step[N];
    for (var i = 0; i < N; i++) {
        step[i] = SubExpSound();
        step[i].cPrevious <== c[i];
        step[i].aPrevious <== a[i];
        step[i].exponentBit <== in[4 + i];
        c[i + 1] <== step[i].cNext;
        a[i + 1] <== step[i].aNext;
    }
    out <== [c[N][0], c[N][1], a[N][0], a[N][1]];
}

component main = SubExpBatch(nSubExpBatch());
