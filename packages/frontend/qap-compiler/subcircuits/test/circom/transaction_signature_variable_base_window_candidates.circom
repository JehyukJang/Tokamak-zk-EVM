pragma circom 2.1.6;

include "./transaction_signature_verify_reference.circom";
include "./transaction_signature_variable_base_window.circom";

template VariableBaseWindowScalarMulTest(N, W) {
    signal input identity[2];
    signal input base[2];
    signal input scalar;
    signal output result[2];

    component scalarBits = Num2Bits(N);
    scalarBits.in <== scalar;

    component core = VariableBaseWindowScalarMulFromConstrainedBits_unsafe(N, W);
    core.identity <== identity;
    core.base <== base;
    core.bits <== scalarBits.out;
    result <== core.result;
}

template VariableBaseBinaryScalarMulTest(N) {
    signal input identity[2];
    signal input base[2];
    signal input scalar;
    signal output result[2];

    component scalarBits = Num2Bits(N);
    scalarBits.in <== scalar;

    component core = JubjubScalarMulFromConstrainedBits_unsafe(N);
    core.identity <== identity;
    core.base <== base;
    core.bits <== scalarBits.out;
    result <== core.result;
}
