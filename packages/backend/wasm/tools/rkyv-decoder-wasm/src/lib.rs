#![deny(unsafe_code)]
#![allow(non_snake_case)]

pub use backend_interface::{
    decode_combined_sigma, ArchiveDecodeError, G1SerdeRkyv, G2SerdeRkyv, Sigma1Rkyv, Sigma2Rkyv,
    SigmaRkyv, SupportedArchiveKind, COMBINED_SIGMA_PAYLOAD_MAGIC, COMBINED_SIGMA_SECTION_COUNT,
    G1_SERIALIZED_BYTES, G2_SERIALIZED_BYTES,
};
use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::JsValue;

#[wasm_bindgen(js_name = decodeCombinedSigma)]
pub fn decode_combined_sigma_wasm(input: &[u8]) -> Result<Vec<u8>, JsValue> {
    decode_combined_sigma(input).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_combined_sigma_archive_into_section_payloads() {
        let sigma = sample_sigma();
        let archive = rkyv::to_bytes::<_, 256>(&sigma).expect("serialize sample sigma");
        let payload = decode_combined_sigma(archive.as_ref()).expect("decode sample sigma");
        let sections = parse_payload(&payload);

        assert_eq!(sections.len(), COMBINED_SIGMA_SECTION_COUNT as usize);
        assert_eq!(sections[0].len(), 6 * G1_SERIALIZED_BYTES);
        assert_eq!(sections[1].len(), 2 * G1_SERIALIZED_BYTES);
        assert_eq!(sections[2].len(), G1_SERIALIZED_BYTES);
        assert_eq!(sections[3].len(), 3 * G1_SERIALIZED_BYTES);
        assert_eq!(sections[4].len(), G1_SERIALIZED_BYTES);
        assert_eq!(sections[5].len(), 3 * G1_SERIALIZED_BYTES);
        assert_eq!(sections[6].len(), G1_SERIALIZED_BYTES);
        assert_eq!(sections[7].len(), 2 * G1_SERIALIZED_BYTES);
        assert_eq!(sections[8].len(), 10 * G2_SERIALIZED_BYTES);

        assert_eq!(&sections[0][0..G1_SERIALIZED_BYTES], &encode_g1(&sigma.G));
        assert_eq!(
            &sections[0][G1_SERIALIZED_BYTES..2 * G1_SERIALIZED_BYTES],
            &encode_g1(&sigma.sigma_1.x)
        );
        assert_eq!(
            &sections[0][5 * G1_SERIALIZED_BYTES..6 * G1_SERIALIZED_BYTES],
            &encode_g1(&sigma.lagrange_KL)
        );
        assert_eq!(&sections[8][0..G2_SERIALIZED_BYTES], &encode_g2(&sigma.H));
        assert_eq!(
            &sections[8][9 * G2_SERIALIZED_BYTES..10 * G2_SERIALIZED_BYTES],
            &encode_g2(&sigma.sigma_2.y)
        );
    }

    #[test]
    fn rejects_invalid_combined_sigma_archive() {
        let error =
            decode_combined_sigma(b"not an archive").expect_err("invalid archive must fail");
        assert_eq!(error.archive_kind(), SupportedArchiveKind::CombinedSigma);
    }

    fn sample_sigma() -> SigmaRkyv {
        SigmaRkyv {
            G: g1(1),
            H: g2(2),
            sigma_1: Sigma1Rkyv {
                xy_powers: vec![g1(3), g1(4)],
                x: g1(5),
                y: g1(6),
                delta: g1(7),
                eta: g1(8),
                gamma_inv_o_inst: vec![g1(9)],
                eta_inv_li_o_inter_alpha4_kj: vec![vec![g1(10), g1(11)], vec![g1(12)]],
                delta_inv_li_o_prv: vec![vec![g1(13)]],
                delta_inv_alphak_xh_tx: vec![vec![g1(14)], vec![g1(15), g1(16)]],
                delta_inv_alpha4_xj_tx: vec![g1(17)],
                delta_inv_alphak_yi_ty: vec![vec![g1(18), g1(19)]],
            },
            sigma_2: Sigma2Rkyv {
                alpha: g2(20),
                alpha2: g2(21),
                alpha3: g2(22),
                alpha4: g2(23),
                gamma: g2(24),
                delta: g2(25),
                eta: g2(26),
                x: g2(27),
                y: g2(28),
            },
            lagrange_KL: g1(29),
        }
    }

    fn g1(seed: u8) -> G1SerdeRkyv {
        let mut x = [0u8; 48];
        let mut y = [0u8; 48];
        for index in 0..48 {
            x[index] = seed.wrapping_add(index as u8);
            y[index] = seed.wrapping_add(48).wrapping_add(index as u8);
        }
        G1SerdeRkyv { x, y }
    }

    fn g2(seed: u8) -> G2SerdeRkyv {
        let mut x = [0u8; 96];
        let mut y = [0u8; 96];
        for index in 0..96 {
            x[index] = seed.wrapping_add(index as u8);
            y[index] = seed.wrapping_add(96).wrapping_add(index as u8);
        }
        G2SerdeRkyv { x, y }
    }

    fn encode_g1(point: &G1SerdeRkyv) -> Vec<u8> {
        let mut output = Vec::with_capacity(G1_SERIALIZED_BYTES);
        output.extend_from_slice(&point.x);
        output.extend_from_slice(&point.y);
        output
    }

    fn encode_g2(point: &G2SerdeRkyv) -> Vec<u8> {
        let mut output = Vec::with_capacity(G2_SERIALIZED_BYTES);
        output.extend_from_slice(&point.x);
        output.extend_from_slice(&point.y);
        output
    }

    fn parse_payload(payload: &[u8]) -> Vec<&[u8]> {
        assert_eq!(&payload[0..8], COMBINED_SIGMA_PAYLOAD_MAGIC);
        let section_count = u32::from_le_bytes(payload[8..12].try_into().unwrap()) as usize;
        let mut lengths = Vec::with_capacity(section_count);
        let mut offset = 12;
        for _ in 0..section_count {
            lengths
                .push(u32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap()) as usize);
            offset += 4;
        }

        let mut sections = Vec::with_capacity(section_count);
        for length in lengths {
            sections.push(&payload[offset..offset + length]);
            offset += length;
        }

        assert_eq!(offset, payload.len());
        sections
    }
}
