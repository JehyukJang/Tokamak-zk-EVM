pragma circom 2.1.6;
// Buffer capacities are measured in 256-bit words.
function nPubIn() {return 58;}
function nLogOut() {return 32;}
function nStorageOut() {return 48;}
function nEVMIn() {return 300;}
function nPrvIn() {return 530;}

function nPoseidonInputs() {return 2;}
function nMtDepth() {return 36;}
function nMtLeaves() {return nPoseidonInputs() ** nMtDepth();}
function nAccumulation() {return 32;}
function nPrevBlockHashes() {return 4;}
function nJubjubExpBatch() {return 128;}
function nSubExpBatch() {return 32;}
function nEqualBatch() {return 2;}
