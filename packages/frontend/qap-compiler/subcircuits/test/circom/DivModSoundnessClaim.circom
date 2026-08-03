pragma circom 2.1.6;

include "../../../templates/256bit/evm_arithmetic.circom";

template DivModSoundnessClaim() {
    signal input dividend[2], divisor[2], claimedQuotient[2], claimedRemainder[2];
    signal actualQuotient[2];
    signal actualRemainder[2];
    (actualQuotient, actualRemainder) <== DivMod256Sound()(dividend, divisor);
    actualQuotient[0] === claimedQuotient[0];
    actualQuotient[1] === claimedQuotient[1];
    actualRemainder[0] === claimedRemainder[0];
    actualRemainder[1] === claimedRemainder[1];
}

component main {public [dividend, divisor, claimedQuotient, claimedRemainder]} = DivModSoundnessClaim();
