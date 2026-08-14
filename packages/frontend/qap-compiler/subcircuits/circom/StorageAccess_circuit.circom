pragma circom 2.1.6;

template StorageAccess() {
    // currentAddress, currentKey[2], canonicalAddress, canonicalKey[2]
    signal input in[6];

    (in[0] - in[3]) * (in[0] - in[3]) === 0;
    (in[0] + in[3]) * (in[0] - in[3]) === in[0] - in[3];

    for (var i = 0; i < 2; i++) {
        (in[1 + i] - in[4 + i]) * (in[1 + i] - in[4 + i]) === 0;
        (in[1 + i] + in[4 + i]) * (in[1 + i] - in[4 + i]) === in[1 + i] - in[4 + i];
    }
}

// Preserve the input interface during standalone Circom compilation.
// The qap-compiler remaps it to free wires when composing this subcircuit.
component main {public [in]} = StorageAccess();
