pragma circom 2.1.6;
include "../../../templates/256bit/arithmetic_safe.circom";

template AddMod257Composed() {
    signal input in[7];
    signal output out[2];

    signal lhs[2] <== [in[1], in[2]];
    signal rhs[2] <== [in[3], in[4]];
    signal modulus[2] <== [in[5], in[6]];
    CheckBus256()(lhs);

    signal numeratorWords[5];
    signal modulusWords[4];
    signal modulusIsZero;
    signal quotientWords[5];
    signal remainderWords[4];
    (numeratorWords, modulusWords, modulusIsZero, quotientWords, remainderWords)
        <== AddMod257Prepare()(in[0], lhs, rhs, modulus);

    out <== AddMod257Verify()(
        numeratorWords,
        modulusWords,
        modulusIsZero,
        quotientWords,
        remainderWords
    );
}

component main {public [in]} = AddMod257Composed();
