pragma circom 2.1.6;
include "../../components/buffer.circom";

// Input wires are public, and output wires are private.

component main {public [in]} = Buffer();