import type { WasmModuleBuilder } from "../kernel-builder-types.js";
import { FIELD_ORDERED_RECURRENCE } from "../kernel-names.js";

/** R[0]=1; R[i+1]=R[i]*F[i]/G[i], in univariate domain order. */
export function buildOrderedRecurrenceKernel(module: WasmModuleBuilder): void {
  const fn = module.addFunction(FIELD_ORDERED_RECURRENCE);
  for (const name of ["f", "inverseG", "count", "one", "out"]) fn.addParam(name, "i32");
  fn.addLocal("i", "i32");
  const c = fn.getCodeBuilder(), term = c.i32_const(module.alloc(32));
  const at = (base: string) => c.i32_add(c.getLocal(base), c.i32_mul(c.getLocal("i"), c.i32_const(32)));
  fn.addCode(
    c.call("frm_copy", c.getLocal("one"), c.getLocal("out")),
    c.setLocal("i", c.i32_const(0)),
    c.block(c.loop(
      c.br_if(1, c.i32_eq(c.i32_add(c.getLocal("i"), c.i32_const(1)), c.getLocal("count"))),
      c.call("frm_mul", at("f"), at("inverseG"), term),
      c.call("frm_mul", at("out"), term, c.i32_add(at("out"), c.i32_const(32))),
      c.setLocal("i", c.i32_add(c.getLocal("i"), c.i32_const(1))),
      c.br(0),
    )),
  );
  module.exportFunction(FIELD_ORDERED_RECURRENCE);
}
