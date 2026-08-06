pragma circom 2.1.6;

include "./transaction_signature_private_word_partition_candidates.circom";

// Non-production representative of a challenge-chain fragment that consumes
// one canonical private word. The separate limb-check fragment must receive
// these exact word wires through the final permutation.
template TransactionSignaturePoseidonPrivateWordAnchorCandidate() {
    signal input previousHash;
    signal input word[2];
    signal output nextHash;

    component boundAndMerge = TransactionSignaturePrivateWordBoundAndMergeCandidate();
    boundAndMerge.in <== word;

    component hash = Poseidon255(2);
    hash.in[0] <== previousHash;
    hash.in[1] <== boundAndMerge.value;
    nextHash <== hash.out;
}

// Test-only composition of the two physical fragments. This wrapper proves
// that the split owns the same local private-word and Poseidon relation when
// both fragments consume the exact same source limbs.
template TransactionSignaturePoseidonPrivateWordAnchorCompositionCandidate() {
    signal input previousHash;
    signal input word[2];
    signal output nextHash;

    component limbCheck = TransactionSignaturePrivateWordLimbCheckCandidate();
    limbCheck.in <== word;

    component anchor = TransactionSignaturePoseidonPrivateWordAnchorCandidate();
    anchor.previousHash <== previousHash;
    anchor.word <== word;
    nextHash <== anchor.nextHash;
}
