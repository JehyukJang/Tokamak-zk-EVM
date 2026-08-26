export type SubcircuitLibraryOrigin = "localQapCompiler" | "npmSnapshot";

export function readSelectedInputOrigin(args: readonly string[]): SubcircuitLibraryOrigin {
  const originFlags = args.filter((argument) => argument.startsWith("--origin="));
  if (originFlags.length > 1) {
    throw new Error("Specify subcircuit-library origin at most once.");
  }
  const origin = originFlags[0]?.slice("--origin=".length) ?? "localQapCompiler";
  if (origin === "localQapCompiler" || origin === "npmSnapshot") {
    return origin;
  }
  throw new Error(
    `Unsupported subcircuit-library origin ${JSON.stringify(origin)}; expected localQapCompiler or npmSnapshot.`,
  );
}
