import type { FfGroup, FfThreadManager, FfWorkerCommand } from "../curve/curve.js";

const WINDOW_BITS = [1, 1, 1, 1, 2, 3, 4, 5, 6, 7, 7, 8, 9, 10, 11, 12,
  13, 13, 14, 15, 16, 16, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17];

/** Two independent MSM outputs share one base delivery per unsigned window. */
export async function pairedG1Msm(group: FfGroup, tm: FfThreadManager, bases: Uint8Array, first: Uint8Array, second: Uint8Array): Promise<readonly [Uint8Array, Uint8Array]> {
  const count = bases.length / 96;
  if (!Number.isInteger(count) || first.length !== count * 32 || second.length !== count * 32) throw new Error("Paired G1 MSM length mismatch.");
  const outputs = [group.zero, group.zero];
  if (count === 0) return [outputs[0]!, outputs[1]!];
  const width = WINDOW_BITS[Math.floor(Math.log2(count))]!, windowCount = Math.ceil(256 / width);
  const chunkSize = Math.max(1024, Math.min(1 << 22, Math.floor(count * windowCount / tm.concurrency)));
  for (let start = 0; start < count; start += chunkSize) {
    const end = Math.min(count, start + chunkSize), n = end - start;
    const bits = WINDOW_BITS[Math.floor(Math.log2(n))]!, windows = Math.ceil(256 / bits);
    const pending: Promise<Uint8Array[]>[] = [];
    for (let w = 0; w < windows; w++) {
      const task: FfWorkerCommand[] = [
        { cmd: "ALLOCSET", var: 0, buff: bases.subarray(start * 96, end * 96) },
        { cmd: "ALLOCSET", var: 1, buff: first.subarray(start * 32, end * 32) },
        { cmd: "ALLOCSET", var: 2, buff: second.subarray(start * 32, end * 32) },
        { cmd: "ALLOC", var: 3, len: 144 },
      ];
      for (let side = 0; side < 2; side++) task.push(
        { cmd: "CALL", fnName: "g1m_multiexpAffine_chunk", params: [
          { var: 0 }, { var: side + 1 }, { val: 32 }, { val: n },
          { val: w * bits }, { val: Math.min(bits, 256 - w * bits) }, { var: 3 },
        ] },
        { cmd: "GET", out: side, var: 3, len: 144 },
      );
      pending.push(tm.queueAction(task));
    }
    const terms = await Promise.all(pending);
    for (let side = 0; side < 2; side++) {
      let sum = group.zero;
      for (let w = terms.length - 1; w >= 0; w--) {
        if (!group.isZero(sum)) for (let bit = 0; bit < bits; bit++) sum = group.double(sum);
        const term = terms[w]![side]!;
        if (!group.isZero(term)) sum = group.isZero(sum) ? term : group.add(sum, term);
      }
      if (!group.isZero(sum)) outputs[side] = group.isZero(outputs[side]!) ? sum : group.add(outputs[side]!, sum);
    }
  }
  return [outputs[0]!, outputs[1]!];
}
