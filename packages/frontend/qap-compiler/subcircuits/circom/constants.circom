pragma circom 2.1.6;
// Buffer capacities are measured in 256-bit words.
function nTxIn() {return 3;}
function nStorageLoad() {return 20;}
function nLogOut() {return 25;}
function nStorageStore() {return 15;}
function nEVMIn() {return 265;}
function nPrvIn() {return 40;}

function nPoseidonInputs() {return 2;}
function nPoseidonBatch() {return 1;}
function nAccumulation() {return 32;}
function nPrevBlockHashes() {return 4;}
function nJubjubExpBatch() {return 37;}
function nSubExpBatch() {return 8;}
function nEqualBatch() {return 2;}
