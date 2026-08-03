pragma circom 2.1.6;

include "../../../templates/256bit/evm_word_sound.circom";

template ShiftSoundnessClaim() {
    signal input shift[2], value[2], claimed[2];
    signal actual[2] <== FullDomainShiftSound(0, 0)(shift, value);
    actual[0] === claimed[0];
    actual[1] === claimed[1];
}

component main {public [shift, value, claimed]} = ShiftSoundnessClaim();
