pragma circom 2.1.6;
include "../../templates/256bit/compare_safe.circom";

// Canonicalizes a 256-bit word and returns the exact checked value so a
// composition can use this placement as its result-producing terminal step.
template CheckBus256PassThrough() {
    signal input in[2];
    signal output out[2];

    CheckBus256()(in);
    out <== in;
}

component main {public [in]} = CheckBus256PassThrough();
