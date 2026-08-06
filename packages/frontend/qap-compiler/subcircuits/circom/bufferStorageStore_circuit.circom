pragma circom 2.1.6;
include "../../templates/buffer.circom";
include "./constants.circom";

// Final storage writes enter through private wires and leave through public wires.
component main{public [in]} = Buffer2(nStorageStore());
