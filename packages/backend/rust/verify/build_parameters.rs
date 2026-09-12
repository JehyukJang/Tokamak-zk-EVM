use std::io;

/// Derive verifier constants only from producer-owned setup parameters.
pub fn generate(bytes: &[u8]) -> io::Result<String> {
    let setup: serde_json::Value = serde_json::from_slice(bytes)?;
    let invalid = |message: String| io::Error::new(io::ErrorKind::InvalidData, message);
    let read = |name: &str| {
        setup[name]
            .as_u64()
            .ok_or_else(|| invalid(format!("{name} must be an unsigned integer")))
    };
    let n = read("n")?;
    let s = read("s_max")?;
    let l = read("l")?;
    let l_d = read("l_D")?;
    let l_free = read("l_free")?;
    let n_a = n
        .checked_mul(s)
        .ok_or_else(|| invalid("N_A overflow".into()))?;
    let n_c = l_d
        .checked_sub(l)
        .and_then(|wires| wires.checked_mul(s))
        .ok_or_else(|| invalid("invalid l_D - l or N_C overflow".into()))?;
    if l_free > l {
        return Err(invalid("l_free exceeds l".into()));
    }
    for (name, size) in [("N_A", n_a), ("N_C", n_c), ("L_FREE", l_free)] {
        // The BLS12-381 scalar field supports radix-two domains up to 2^32.
        if !size.is_power_of_two() || size > (1u64 << 32) {
            return Err(invalid(format!(
                "{name} must be a power of two at most 2^32"
            )));
        }
    }
    Ok(format!(
        "// Generated from the selected subcircuit library at build time.\n\
         pub const N_A: u64 = {n_a};\n\
         pub const N_C: u64 = {n_c};\n\
         pub const L_FREE: u64 = {l_free};\n"
    ))
}
