pragma circom 2.1.6;

include "../../../templates/256bit/arithmetic_sound.circom";

template MulSoundnessClaim() {
    signal input lhs[2], rhs[2], claimed[2];
    signal actual[2] <== Mul256TruncatedSound()(lhs, rhs);
    actual[0] === claimed[0];
    actual[1] === claimed[1];
}

component main {public [lhs, rhs, claimed]} = MulSoundnessClaim();
