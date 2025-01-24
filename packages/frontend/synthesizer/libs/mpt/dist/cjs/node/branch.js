"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BranchMPTNode = void 0;
const rlp_1 = require("@ethereumjs/rlp");
class BranchMPTNode {
    constructor() {
        this._branches = new Array(16).fill(null);
        this._value = null;
    }
    static fromArray(arr) {
        const node = new BranchMPTNode();
        node._branches = arr.slice(0, 16);
        node._value = arr[16];
        return node;
    }
    value(v) {
        if (v !== null && v !== undefined) {
            this._value = v;
        }
        return this._value && this._value.length > 0 ? this._value : null;
    }
    setBranch(i, v) {
        this._branches[i] = v;
    }
    raw() {
        return [...this._branches, this._value];
    }
    serialize() {
        return rlp_1.RLP.encode(this.raw());
    }
    getBranch(i) {
        const b = this._branches[i];
        if (b !== null && b.length > 0) {
            return b;
        }
        else {
            return null;
        }
    }
    getChildren() {
        const children = [];
        for (let i = 0; i < 16; i++) {
            const b = this._branches[i];
            if (b !== null && b.length > 0) {
                children.push([i, b]);
            }
        }
        return children;
    }
}
exports.BranchMPTNode = BranchMPTNode;
//# sourceMappingURL=branch.js.map