pragma circom 2.1.6;

include "./transaction_signature_verify_reference.circom";

template AffinePublicKeyCofactorTest() {
    signal input point[2];
    signal output result[2];

    component cofactor = JubjubMulByCofactor8FromValidPoint_unsafe();
    cofactor.point <== point;
    result <== cofactor.point8;
}

template ExtendedPublicKeyCofactorTest() {
    signal input point[2];
    signal output result[2];

    component cofactor = AffineJubjubMulByCofactor8Extended_unsafe();
    cofactor.point <== point;
    component affine = ExtendedJubjubToAffine_unsafe();
    affine.point <== cofactor.point8;
    result <== affine.affine;
}

template AffineRandomizerCofactorTerminalTest() {
    signal input randomizer[2];
    signal input challenge[4];
    signal output result[2];

    component cofactor = JubjubMulByCofactor8FromValidPoint_unsafe();
    cofactor.point <== randomizer;
    component addition = ExtendedJubjubAddAffine_unsafe();
    addition.point <== challenge;
    addition.affine <== cofactor.point8;
    component affine = ExtendedJubjubToAffine_unsafe();
    affine.point <== addition.result;
    result <== affine.affine;
}

template ExtendedRandomizerCofactorTerminalTest() {
    signal input randomizer[2];
    signal input challenge[4];
    signal output result[2];

    component cofactor = AffineJubjubMulByCofactor8Extended_unsafe();
    cofactor.point <== randomizer;
    component addition = ExtendedJubjubAdd_unsafe();
    addition.point1 <== challenge;
    addition.point2 <== cofactor.point8;
    component affine = ExtendedJubjubToAffine_unsafe();
    affine.point <== addition.result;
    result <== affine.affine;
}
