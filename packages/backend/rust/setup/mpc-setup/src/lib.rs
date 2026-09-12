//! Current-protocol MPC phase 2. Source preparation is internal to participants;
//! this crate neither implements phase 1 nor exposes a standalone import API.

// Participant operation wiring is pending. Keep this ingress private
// instead of exposing an independently trusted source-conversion product.
#[expect(
    dead_code,
    reason = "phase 2 participant operation wiring is not implemented yet"
)]
pub(crate) mod filecoin_source;

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "phase 2 participant operation wiring is not implemented yet"
    )
)]
mod contribution_proof;
