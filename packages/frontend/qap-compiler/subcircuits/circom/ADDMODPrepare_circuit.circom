pragma circom 2.1.6;
include "../../templates/256bit/arithmetic_safe.circom";

template ADDMODPrepare_() {
    signal input in[7];
    signal output out[19];

    signal numeratorWords[5];
    signal modulusWords[4];
    signal modulusIsZero;
    signal quotientWords[5];
    signal remainderWords[4];
    (numeratorWords, modulusWords, modulusIsZero, quotientWords, remainderWords)
        <== AddMod257Prepare()(in[0], [in[1], in[2]], [in[3], in[4]], [in[5], in[6]]);

    for (var word = 0; word < 5; word++) {
        out[word] <== numeratorWords[word];
    }
    for (var word = 0; word < 4; word++) {
        out[5 + word] <== modulusWords[word];
    }
    out[9] <== modulusIsZero;
    for (var word = 0; word < 5; word++) {
        out[10 + word] <== quotientWords[word];
    }
    for (var word = 0; word < 4; word++) {
        out[15 + word] <== remainderWords[word];
    }
}

component main {public [in]} = ADDMODPrepare_();
