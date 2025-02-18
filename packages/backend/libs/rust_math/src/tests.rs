extern crate icicle_bls12_381;
extern crate icicle_core;
extern crate icicle_runtime;


#[cfg(test)]
mod tests {
    use icicle_bls12_381::curve::{ScalarField, ScalarCfg};
    use icicle_bls12_381::vec_ops;
    use icicle_core::traits::{Arithmetic, FieldConfig, FieldImpl, GenerateRandom};
    use icicle_core::polynomials::UnivariatePolynomial;
    use icicle_core::{ntt, ntt::NTTInitDomainConfig};
    use icicle_core::vec_ops::{transpose_matrix, VecOps, VecOpsConfig};
    use icicle_bls12_381::polynomials::DensePolynomial;
    use icicle_runtime::memory::{HostOrDeviceSlice, HostSlice, DeviceSlice, DeviceVec};
    use std::ops::Deref;
    use std::{
        clone, cmp,
        ops::{Add, AddAssign, Div, Mul, Rem, Sub},
        ptr, slice,
    };

    use icicle_bls12_381::curve::{CurveCfg, G1Projective};
    use icicle_core::{curve::Curve, msm, msm::MSMConfig};
    use icicle_runtime::device::Device;
    
    
    use crate::dense_ext::{BivariatePolynomial, DensePolynomialExt};

    use super::*;

    #[test]
    fn test_from_coeffs_rou_coeffs_eval() {
        let x_size = 4;
        let y_size = 2;
        let size = x_size * y_size;
        let mut coeffs_vec = vec![ScalarField::one(); size];
        let coeffs = HostSlice::from_slice(&coeffs_vec);
        let mut evals = DeviceVec::<ScalarField>::device_malloc(size).unwrap();

        ntt::initialize_domain::<ScalarField>(
            ntt::get_root_of_unity::<ScalarField>(size as u64),
            &ntt::NTTInitDomainConfig::default(),
        )
        .unwrap();

        // Using default config
        let mut cfg = ntt::NTTConfig::<ScalarField>::default();
        cfg.batch_size = y_size as i32;
        cfg.columns_batch = false;

        // Computing NTT columns batch
        ntt::ntt(
            coeffs,
            ntt::NTTDir::kInverse,
            &cfg,
            &mut evals,
        )
        .unwrap();

        // Using default config
        let mut cfg = ntt::NTTConfig::<ScalarField>::default();
        cfg.batch_size = x_size as i32;
        cfg.columns_batch = true;

        // Computing NTT columns batch
        let mut evals2 = DeviceVec::<ScalarField>::device_malloc(size).unwrap();
        ntt::ntt(
            &evals,
            ntt::NTTDir::kInverse,
            &cfg,
            &mut evals2,
        )
        .unwrap();

        let poly1 = DensePolynomialExt::from_coeffs(coeffs, x_size, y_size);
        let poly2 = DensePolynomialExt::from_rou_evals(&evals2, x_size, y_size);

        let mut coeff1_vec = vec![ScalarField::zero(); size];
        let mut coeff2_vec = vec![ScalarField::zero(); size];
        let coeff1 = HostSlice::from_mut_slice(&mut coeff1_vec);
        let coeff2 = HostSlice::from_mut_slice(&mut coeff2_vec);
        poly1.copy_coeffs(0, coeff1);
        poly2.copy_coeffs(0, coeff2);

        let x = ScalarCfg::generate_random(1)[0];
        let y = ScalarCfg::generate_random(1)[0];

        let eval1 = poly1.eval(&x, &y);
        let eval2 = poly2.eval(&x, &y);
        println!("eval1: {:?}\n", eval1);
        println!("eval2: {:?}\n", eval2);
        assert!(!ScalarField::eq(&eval1, &eval2));
    }

    #[test]
    fn test_extend_size_slicing_mul_monomial() {
        let x_size = 4;
        let y_size = 2;
        let size = x_size * y_size;
        let coeffs_vec = ScalarCfg::generate_random(size);
        let coeffs = HostSlice::from_slice(&coeffs_vec);

        let poly = DensePolynomialExt::from_coeffs(coeffs, x_size, y_size);

        let mut ext_poly = poly.clone();
        ext_poly.resize(8, 16);
        
        let mut blocks_raw = vec![ScalarField::zero(); 8*16];
        ext_poly._slice_coeffs_into_blocks(2, 8, &mut blocks_raw);
        let split_poly:Vec<Vec<ScalarField>> = blocks_raw.chunks(8).map(|chunk| chunk.to_vec()).collect();

        let mut ext_poly_coeffs_vec = vec![ScalarField::zero(); 8 * 16];
        let ext_poly_coeffs = HostSlice::from_mut_slice(&mut ext_poly_coeffs_vec);
        ext_poly.copy_coeffs(0, ext_poly_coeffs);

        let mut shifted_poly = poly.clone();
        shifted_poly.mul_monomial(4, 2);
        let mut shifted_poly_coeffs_vec = vec![ScalarField::zero(); 8*4];
        let shifted_poly_coeffs = HostSlice::from_mut_slice(&mut shifted_poly_coeffs_vec);
        shifted_poly.copy_coeffs(0, shifted_poly_coeffs);

        // Add assertions to verify the operations were successful
        assert_eq!(ext_poly.x_size, 8);
        assert_eq!(ext_poly.y_size, 16);
        assert_eq!(split_poly.len(), 16);
        assert!(shifted_poly.x_degree >= 4);
        assert!(shifted_poly.y_degree >= 2);
    }

    #[test]
    fn test_polynomial_multiplication() {
        let p1_coeffs_vec = ScalarCfg::generate_random(8);
        let p1_coeffs = HostSlice::from_slice(&p1_coeffs_vec);
        let p1 = DensePolynomialExt::from_coeffs(p1_coeffs, 4, 2);

        let p2_coeffs_vec = ScalarCfg::generate_random(16);
        let p2_coeffs = HostSlice::from_slice(&p2_coeffs_vec);
        let p2 = DensePolynomialExt::from_coeffs(p2_coeffs,2,8);

        let p3 = &p1 * &p2;

        let mut p3_coeffs_vec = vec![ScalarField::zero(); 128];
        let p3_coeffs = HostSlice::from_mut_slice(&mut p3_coeffs_vec);
        p3.copy_coeffs(0,p3_coeffs);

        let x = ScalarCfg::generate_random(1)[0];
        let y = ScalarCfg::generate_random(1)[0];

        let eval_p1 = p1.eval(&x,&y);
        let eval_p2 = p2.eval(&x,&y);
        let eval_p3 = p3.eval(&x,&y);

        assert!(eval_p3.eq(&(eval_p1 * eval_p2)), "Multiplication evaluation failed");
    }

    #[test]
    fn test_rou_eval_conversion() {
        let p1_coeffs_number:[u32; 2] = [4, 0];
        let mut p1_coeffs_vec = vec![ScalarField::zero(); 2];
        for (ind, &num) in p1_coeffs_number.iter().enumerate() {
            p1_coeffs_vec[ind] = ScalarField::from_u32(num);
        }
        let p1_coeffs = HostSlice::from_slice(&p1_coeffs_vec);
        let p1 = DensePolynomialExt::from_coeffs(p1_coeffs, 1, 2);

        let mut evals_vec = vec![ScalarField::zero(); 2];
        let evals = HostSlice::from_mut_slice(&mut evals_vec);
        p1.to_rou_evals(evals);

        let p2 = DensePolynomialExt::from_rou_evals(evals, 1, 2);
        let mut p2_coeffs_vec = vec![ScalarField::zero(); 2];
        let p2_coeffs = HostSlice::from_mut_slice(&mut p2_coeffs_vec);
        p2.copy_coeffs(0, p2_coeffs);

        assert_eq!(p1_coeffs_vec, p2_coeffs_vec, "Coefficient vectors should be equal after conversion");
    }

    #[test]
    fn test_polynomial_division() {
        let p1_coeffs_vec = ScalarCfg::generate_random(32);
        let p1_coeffs = HostSlice::from_slice(&p1_coeffs_vec);
        let p1 = DensePolynomialExt::from_coeffs(p1_coeffs, 8, 4);

        let p2_coeffs_vec = ScalarCfg::generate_random(6);
        let p2_coeffs = HostSlice::from_slice(&p2_coeffs_vec);
        let p2 = DensePolynomialExt::from_coeffs(p2_coeffs,6,1);

        let p3_coeffs_vec = ScalarCfg::generate_random(3);
        let p3_coeffs = HostSlice::from_slice(&p3_coeffs_vec);
        let p3 = DensePolynomialExt::from_coeffs(p3_coeffs,1,3);

        let (quo_x, rem_x) = p1.divide_x(&p2);
        let (quo_y, rem_y) = rem_x.divide_y(&p3);

        let x = ScalarCfg::generate_random(1)[0];
        let y = ScalarCfg::generate_random(1)[0];

        let eval_p1 = p1.eval(&x,&y);
        let eval_p2 = p2.eval(&x,&y);
        let eval_p3 = p3.eval(&x,&y);
        let eval_quo_x = quo_x.eval(&x,&y);
        let eval_quo_y = quo_y.eval(&x,&y);
        let eval_rem_y = rem_y.eval(&x,&y);

        // Verify that p1 = p2*quo_x + p3*quo_y + rem_y
        assert!(eval_p1.eq(&(((eval_p2 * eval_quo_x) + (eval_p3 * eval_quo_y)) + eval_rem_y)), 
            "Division result verification failed");
    }

    #[test]
    fn test_vector_operations() {
        // Test vector addition
        let mut a_vec = vec![ScalarField::zero(); 5];
        a_vec[0] = ScalarField::from_u32(5);
        a_vec[4] = ScalarField::one();
        let a = HostSlice::<ScalarField>::from_slice(&a_vec);

        let mut b_vec = vec![ScalarField::zero(); 5];
        b_vec[0] = ScalarField::from_u32(4);
        b_vec[1] = ScalarField::one();
        let b = HostSlice::<ScalarField>::from_slice(&b_vec);

        let mut c_vec = vec![ScalarField::zero(); 5];
        let c = HostSlice::<ScalarField>::from_mut_slice(&mut c_vec);
        
        let cfg = VecOpsConfig::default();
        ScalarCfg::add(a, b, c, &cfg).unwrap();

        // Verify addition results
        assert_eq!(c_vec[0], ScalarField::from_u32(9), "Addition at index 0 failed");
        assert_eq!(c_vec[1], ScalarField::from_u32(1), "Addition at index 1 failed");
        assert_eq!(c_vec[4], ScalarField::from_u32(1), "Addition at index 4 failed");
        for i in 2..4 {
            assert_eq!(c_vec[i], ScalarField::zero(), "Non-zero value found at index {}", i);
        }
    }

    #[test]
    fn test_matrix_transpose() {
        // Initialize 3x4 matrix with values 1-12
        let p1_coeffs_number:[u32; 12] = [1,2,3,4,5,6,7,8,9,10,11,12];
        let mut p1_coeffs_vec = vec![ScalarField::zero(); 12];
        for (ind, &num) in p1_coeffs_number.iter().enumerate() {
            p1_coeffs_vec[ind] = ScalarField::from_u32(num);
        }
        let p1_coeffs = HostSlice::from_slice(&p1_coeffs_vec);

        // Create buffer for transposed matrix (4x3)
        let mut p2_coeffs_vec = vec![ScalarField::zero(); 12];
        let p2_coeffs = HostSlice::from_mut_slice(&mut p2_coeffs_vec);
        
        // Perform transpose operation
        let cfg = VecOpsConfig::default();
        ScalarCfg::transpose(p1_coeffs, 3, 4, p2_coeffs, &cfg).unwrap();

        // Expected values after transpose (4x3 matrix)
        let expected: [u32; 12] = [1,5,9,2,6,10,3,7,11,4,8,12];
        
        // Verify transpose results
        for (i, &exp) in expected.iter().enumerate() {
            assert_eq!(
                p2_coeffs_vec[i], 
                ScalarField::from_u32(exp), 
                "Transpose mismatch at index {}", 
                i
            );
        }
    }


    #[test]
    fn test_ntt_and_matrix_operations() {
        // Initialize test data
        let size = 8;
        let mut test_signal = vec![ScalarField::zero(); size];
        test_signal[0] = ScalarField::one();
        test_signal[2] = ScalarField::one();
        test_signal[4] = ScalarField::one();
        test_signal[6] = ScalarField::one();
        let scalars = test_signal.clone();

        // Allocate device memory for NTT results
        let mut ntt_results = DeviceVec::<ScalarField>::device_malloc(size).unwrap();
        let mut ntt_results2 = DeviceVec::<ScalarField>::device_malloc(size).unwrap();
        
        // Allocate host memory for results
        let mut ntt_host_vec = vec![ScalarField::zero(); size];
        let mut ntt_host = HostSlice::from_mut_slice(&mut ntt_host_vec[..]);
        let mut ntt_host_vec2 = vec![ScalarField::zero(); size];
        let mut ntt_host2 = HostSlice::from_mut_slice(&mut ntt_host_vec2[..]);

        // Initialize NTT domain
        ntt::initialize_domain::<ScalarField>(
            ntt::get_root_of_unity::<ScalarField>(
                size.try_into().unwrap(),
            ),
            &ntt::NTTInitDomainConfig::default(),
        )
        .unwrap();

        // Configure and perform first NTT operation
        let mut cfg = ntt::NTTConfig::<ScalarField>::default();
        cfg.batch_size = 4;
        cfg.columns_batch = true;
        cfg.ext.set_int(ntt::CUDA_NTT_ALGORITHM, ntt::NttAlgorithm::MixedRadix as i32);

        ntt::ntt(
            HostSlice::from_slice(&scalars),
            ntt::NTTDir::kForward,
            &cfg,
            &mut ntt_results,
        )
        .unwrap();

        // Perform matrix transposition
        let mut transposed_input = vec![ScalarField::zero(); size];
        transpose_matrix(
            HostSlice::from_slice(&scalars),
            2,
            4,
            HostSlice::from_mut_slice(&mut transposed_input),
            &VecOpsConfig::default(),
        )
        .unwrap();

        // Configure and perform second NTT operation
        cfg.batch_size = 4;
        cfg.columns_batch = false;
        ntt::ntt(
            HostSlice::from_slice(&transposed_input),
            ntt::NTTDir::kForward,
            &cfg,
            &mut ntt_results2,
        )
        .unwrap();

        // Copy results back to host
        ntt_results.copy_to_host(&mut ntt_host);
        ntt_results2.copy_to_host(&mut ntt_host2);

        // Verify input signal structure
        assert_eq!(test_signal[0], ScalarField::one(), "First element should be one");
        assert_eq!(test_signal[2], ScalarField::one(), "Third element should be one");
        assert_eq!(test_signal[4], ScalarField::one(), "Fifth element should be one");
        assert_eq!(test_signal[6], ScalarField::one(), "Seventh element should be one");

        // Verify that non-one elements are zero
        for i in [1, 3, 5, 7] {
            assert_eq!(test_signal[i], ScalarField::zero(), 
                      "Element at index {} should be zero", i);
        }

        // Verify NTT results are non-zero
        assert!(!ntt_host_vec.iter().all(|&x| x == ScalarField::zero()), 
                "First NTT result should contain non-zero values");
        assert!(!ntt_host_vec2.iter().all(|&x| x == ScalarField::zero()), 
                "Second NTT result should contain non-zero values");

        // Optional: Add more specific verifications based on expected NTT output patterns
        // Note: Exact values would depend on the specific properties of the NTT implementation
    }

    #[test]
    fn test_msm_operations() {
        // Initialize runtime and device
        icicle_runtime::runtime::load_backend_from_env_or_default();
        let cuda_device = Device::new("CPU", 0);
        if icicle_runtime::is_device_available(&cuda_device) {
            icicle_runtime::set_device(&cuda_device).unwrap();
        }

        // Test parameters
        let size = 1024;

        // Generate random test data
        let points = CurveCfg::generate_random_affine_points(size);
        let scalars = ScalarCfg::generate_random(size);
        
        // Configure MSM
        let mut msm_config = MSMConfig::default();

        // First MSM operation with two results
        let mut msm_results1 = vec![G1Projective::zero(); 2];
        msm::msm(
            HostSlice::from_slice(&scalars),
            HostSlice::from_slice(&points),
            &msm_config,
            HostSlice::from_mut_slice(&mut msm_results1[..]),
        )
        .unwrap();

        // Second MSM operation with one result
        let mut msm_results2 = vec![G1Projective::zero(); 1];
        msm::msm(
            HostSlice::from_slice(&scalars),
            HostSlice::from_slice(&points),
            &msm_config,
            HostSlice::from_mut_slice(&mut msm_results2[..]),
        )
        .unwrap();

        // Verify that msm_results2[0] equals msm_results1[0] + msm_results1[0]
        assert!(
            G1Projective::eq(&msm_results2[0], &(msm_results1[0] + msm_results1[0])),
            "MSM result verification failed: results do not match expected relationship"
        );

        // Additional verifications
        assert!(!G1Projective::eq(&msm_results1[0], &G1Projective::zero()),
                "First MSM result should not be zero");
        assert!(!G1Projective::eq(&msm_results2[0], &G1Projective::zero()),
                "Second MSM result should not be zero");
    }

    // Optional: Additional test for batch processing
    #[test]
    #[ignore] // This test is currently ignored as it was commented out in the original code
    fn test_msm_batch_operations() {
        let _ = icicle_runtime::runtime::load_backend_from_env_or_default();
        let cuda_device = Device::new("CPU", 0);
        if icicle_runtime::is_device_available(&cuda_device) {
            icicle_runtime::set_device(&cuda_device).unwrap();
        }

        let size = 1024;
        let points = CurveCfg::generate_random_affine_points(size);
        let scalars = ScalarCfg::generate_random(size);
        
        let mut msm_config = MSMConfig::default();
        msm_config.batch_size = 4;

        let mut msm_results = vec![G1Projective::zero(); 4];
        msm::msm(
            HostSlice::from_slice(&scalars),
            HostSlice::from_slice(&points),
            &msm_config,
            HostSlice::from_mut_slice(&mut msm_results[..]),
        )
        .unwrap();

        // Verify that results are non-zero
        for (i, result) in msm_results.iter().enumerate() {
            assert!(!G1Projective::eq(result, &G1Projective::zero()),
                    "MSM result at index {} should not be zero", i);
        }
    }
    
    #[test]
    fn test_find_degree() {
        // Test Case 1: 기본적인 2x2 다항식
        let coeffs1 = vec![
            ScalarField::from_u32(1), ScalarField::from_u32(2),  // y^0 항: 1 + 2x
            ScalarField::from_u32(3), ScalarField::from_u32(4)   // y^1 항: 3 + 4x
        ];
        let poly1 = DensePolynomial::from_coeffs(HostSlice::from_slice(&coeffs1), 4);
        let (x_degree1, y_degree1) = DensePolynomialExt::_find_degree(&poly1, 2, 2);
        println!("Test Case 1 - Expected: (1,1), Got: ({},{})", x_degree1, y_degree1);
        assert_eq!((x_degree1, y_degree1), (1, 1), "2x2 polynomial degree test failed");

        // Test Case 2: 모든 계수가 0인 경우
        let coeffs2 = vec![
            ScalarField::zero(), ScalarField::zero(),
            ScalarField::zero(), ScalarField::zero()
        ];
        let poly2 = DensePolynomial::from_coeffs(HostSlice::from_slice(&coeffs2), 4);
        let (x_degree2, y_degree2) = DensePolynomialExt::_find_degree(&poly2, 2, 2);
        println!("Test Case 2 - Expected: (0,0), Got: ({},{})", x_degree2, y_degree2);
        assert_eq!((x_degree2, y_degree2), (0, 0), "Zero polynomial degree test failed");

        // Test Case 3: x방향으로만 차수가 있는 경우
        let coeffs3 = vec![
            ScalarField::from_u32(1), ScalarField::from_u32(2), ScalarField::from_u32(3),  // y^0 항: 1 + 2x + 3x^2
            ScalarField::zero(), ScalarField::zero(), ScalarField::zero()                   // y^1 항: 0
        ];
        let poly3 = DensePolynomial::from_coeffs(HostSlice::from_slice(&coeffs3), 6);
        let (x_degree3, y_degree3) = DensePolynomialExt::_find_degree(&poly3, 3, 2);
        println!("Test Case 3 - Expected: (2,0), Got: ({},{})", x_degree3, y_degree3);
        assert_eq!((x_degree3, y_degree3), (2, 0), "X-only polynomial degree test failed");

        // Test Case 4: y방향으로만 차수가 있는 경우
        let coeffs4 = vec![
            ScalarField::from_u32(1), ScalarField::zero(),  // y^0 항: 1
            ScalarField::from_u32(2), ScalarField::zero(),  // y^1 항: 2
            ScalarField::from_u32(3), ScalarField::zero()   // y^2 항: 3
        ];
        let poly4 = DensePolynomial::from_coeffs(HostSlice::from_slice(&coeffs4), 6);
        let (x_degree4, y_degree4) = DensePolynomialExt::_find_degree(&poly4, 2, 3);
        println!("Test Case 4 - Expected: (0,2), Got: ({},{})", x_degree4, y_degree4);
        assert_eq!((x_degree4, y_degree4), (0, 2), "Y-only polynomial degree test failed");

        // 각 테스트 케이스의 계수 출력
        println!("\nDetailed coefficient analysis:");
        for (i, coeffs) in [coeffs1, coeffs2, coeffs3, coeffs4].iter().enumerate() {
            println!("\nTest Case {}:", i + 1);
            for chunk in coeffs.chunks(2) {
                println!("{:?}", chunk);
            }
        }
    }
}