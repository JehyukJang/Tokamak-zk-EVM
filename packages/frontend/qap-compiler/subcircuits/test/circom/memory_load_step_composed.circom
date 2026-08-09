pragma circom 2.1.6;

include "../../../templates/256bit/memory_load.circom";

template MemoryLoadStepComposed() {
    // Two source limbs, shift, direction, and ownership for each step,
    // followed by the expected final ownership.
    signal input in[11];
    signal output out[3];

    component first = MemoryLoadStep();
    first.in[0] <== in[0];
    first.in[1] <== in[1];
    first.in[2] <== in[2];
    first.in[3] <== in[3];
    first.in[4] <== in[4];
    first.in[5] <== 0;
    first.in[6] <== 0;
    first.in[7] <== 0;
    first.in[8] <== in[10];
    first.in[9] <== 0;

    component second = MemoryLoadStep();
    second.in[0] <== in[5];
    second.in[1] <== in[6];
    second.in[2] <== in[7];
    second.in[3] <== in[8];
    second.in[4] <== in[9];
    second.in[5] <== first.out[0];
    second.in[6] <== first.out[1];
    second.in[7] <== first.out[2];
    second.in[8] <== in[10];
    second.in[9] <== 1;

    out <== second.out;
}

component main {public [in]} = MemoryLoadStepComposed();
