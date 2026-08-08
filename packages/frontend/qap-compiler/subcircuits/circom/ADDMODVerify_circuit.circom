pragma circom 2.1.6;
include "../../templates/256bit/arithmetic_safe.circom";

template ADDMODVerify_() {
    signal input in[19];
    signal output out[2];

    signal numeratorWords[5];
    signal modulusWords[4];
    signal quotientWords[5];
    signal remainderWords[4];
    for (var word = 0; word < 5; word++) {
        numeratorWords[word] <== in[word];
        quotientWords[word] <== in[10 + word];
    }
    for (var word = 0; word < 4; word++) {
        modulusWords[word] <== in[5 + word];
        remainderWords[word] <== in[15 + word];
    }

    out <== AddMod257Verify()(
        numeratorWords,
        modulusWords,
        in[9],
        quotientWords,
        remainderWords
    );
}

component main {public [in]} = ADDMODVerify_();
