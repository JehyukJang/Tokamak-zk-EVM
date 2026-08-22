# Prove Timing Report

## Total Time

| item | value |
| --- | --- |
| total_wall | 11.112068 s |

## Timing Boundaries

- `encode` includes only the MSM call inside polynomial encoding.
- Polynomial work needed before encoding is reported under `poly`, usually as `combine`, `add`, `mul`, or `eval`.
- `div_by_vanishing_opt` and `div_by_ruffini` include only the division calls; numerator construction is reported separately under `poly`.
- Raw JSON may contain `encode_call` spans for outer diagnostics, but they are excluded from the encode summary tables.

## Setup Parameters

| param | value |
| --- | --- |
| l_free | 256 |
| l | 396 |
| l_user_out | 130 |
| l_user | 134 |
| l_D | 1420 |
| m_D | 24079 |
| n | 1024 |
| s_D | 44 |
| s_max | 256 |

## Module Times (init + prove0~prove4)

| module | total | poly | encode |
| --- | --- | --- | --- |
| init | 1.097210 s | - | - |
| prove0 | 2.534277 s | 0.288990 s | 2.219785 s |
| prove1 | 0.601249 s | 0.227828 s | 0.360972 s |
| prove2 | 3.254933 s | 1.459325 s | 1.728697 s |
| prove3 | 0.342266 s | 0.059181 s | 0.000000 s |
| prove4 | 3.281311 s | 1.766793 s | 1.485590 s |

## Init Details (load/build)

| phase | variable | time | dims |
| --- | --- | --- | --- |
| build | A_free | 0.002065 s | A_free=256x1 |
| build | O_mid_core | 0.003186 s | O_mid_core=1420x1 |
| build | O_prv_core | 0.107077 s | O_prv_core=1420x1 |
| build | O_pub_free | 0.001117 s | O_pub_free=256x1 |
| build | a_free_X | 0.000089 s | a_free_X=256x1 |
| build | bXY | 0.013072 s | bXY=1024x256 |
| build | s0_s1 | 0.024461 s | s0/s1=1024x256 |
| build | t_mi | 0.000002 s | t_mi=2048x1 |
| build | t_n | 0.000003 s | t_n=2048x1 |
| build | t_smax | 0.000002 s | t_smax=1x512 |
| build | uvwXY | 0.053859 s | uXY/vXY/wXY=1024x256 |
| load | instance | 0.000056 s | file_bytes=6726 |
| load | permutation | 0.000268 s | file_bytes=96006 |
| load | placement_variables | 0.010492 s | file_bytes=3553110 |
| load | setup_params | 0.000038 s | file_bytes=269 |
| load | sigma | 0.066938 s | file_bytes=682929000 |
| load | subcircuit_infos | 0.000449 s | file_bytes=155559 |

## Category Totals

| category | total |
| --- | --- |
| poly | 3.802117 s |
| encode | 5.796931 s |

## Poly Operation Totals

| operation | total |
| --- | --- |
| add | 0.008267 s |
| combine | 2.167074 s |
| div_by_ruffini | 0.287565 s |
| div_by_ruffini_shared_x | 0.263894 s |
| div_by_vanishing_opt | 0.059774 s |
| eval | 0.718905 s |
| eval_derived | 0.000001 s |
| eval_three_batch | 0.059181 s |
| from_rou_evals | 0.012987 s |
| mul | 0.002581 s |
| recursion_eval | 0.184311 s |
| scale_coeffs | 0.014796 s |
| to_rou_evals | 0.022780 s |

## Poly Operation Details (by variable)

| operation | module | variable | time | dims |
| --- | --- | --- | --- | --- |
| add | prove4 | RXY | 0.003720 s | R=1024x256 |
| add | prove4 | RXY_terms | 0.003337 s | m_i_s_max=1024x256 |
| add | prove4 | g_minus_f | 0.001210 s | gXY=1024x256 |
| combine | prove0 | B | 0.008110 s | B=1024x256 |
| combine | prove0 | Q_AX | 0.021624 s | Q_AX=2048x512 |
| combine | prove0 | Q_AY | 0.019774 s | Q_AY=1024x512 |
| combine | prove0 | U | 0.009108 s | U=1024x256 |
| combine | prove0 | V | 0.009544 s | V=1024x256 |
| combine | prove0 | W | 0.007978 s | W=1024x256 |
| combine | prove0 | p0XY | 0.189804 s | p0XY=1024x256 |
| combine | prove1 | R | 0.008406 s | R=1024x256 |
| combine | prove2 | Q_CX | 0.139342 s | Q_CX=4096x512 |
| combine | prove2 | Q_CY | 0.227767 s | Q_CY=1024x512 |
| combine | prove2 | p_comb | 1.050737 s | p_comb=1024x256 |
| combine | prove4 | LHS_for_copy | 0.043307 s | m_i_s_max=1024x256 |
| combine | prove4 | LHS_zk1 | 0.071396 s | m_i_s_max=1024x256 |
| combine | prove4 | LHS_zk2 | 0.218395 s | m_i_s_max=1024x256 |
| combine | prove4 | Pi_A | 0.053279 s | uXY=1024x256 |
| combine | prove4 | Pi_combined_numerator | 0.015940 s | m_i_s_max=1024x256 |
| combine | prove4 | V | 0.008443 s | vXY=1024x256 |
| combine | prove4 | fXY | 0.006210 s | bXY=1024x256 |
| combine | prove4 | gXY | 0.003568 s | bXY=1024x256 |
| combine | prove4 | pC | 0.045329 s | m_i_s_max=1024x256 |
| combine | prove4 | term5 | 0.004716 s | gXY=1024x256 |
| combine | prove4 | term6 | 0.004300 s | gXY=1024x256 |
| div_by_ruffini | prove4 | Pi_combined | 0.287565 s | m_i_s_max=1024x256 |
| div_by_ruffini_shared_x | prove4 | M_N | 0.263894 s | R=1024x256 |
| div_by_vanishing_opt | prove0 | q0q1 | 0.023050 s | vanishing=1024x256 |
| div_by_vanishing_opt | prove2 | qCXqCY | 0.036725 s | vanishing=1024x256 |
| eval | prove4 | A_free | 0.001092 s | a_free_X=256x1 |
| eval | prove4 | K0 | 0.001026 s | K0=1024x1 |
| eval | prove4 | R | 0.123879 s | R=1024x256 |
| eval | prove4 | R_omegaX | 0.123450 s | R_omegaX=1024x256 |
| eval | prove4 | R_omegaX_omegaY | 0.124158 s | R_omegaX_omegaY=1024x256 |
| eval | prove4 | t_n | 0.001076 s | t_n=2048x1 |
| eval | prove4 | t_smax | 0.221780 s | t_smax=1x512 |
| eval | prove4 | vXY | 0.122445 s | vXY=1024x256 |
| eval_derived | prove4 | r_D1_r_D2 | 0.000001 s | evaluations=2 |
| eval_three_batch | prove3 | R | 0.059181 s | R=2048x512 |
| from_rou_evals | prove1 | rXY | 0.012332 s | rXY_evals=262144, grid=1024x256 |
| from_rou_evals | prove2 | K | 0.000204 s | k_evals=1024, grid=1024x1 |
| from_rou_evals | prove2 | K0 | 0.000215 s | k0_evals=1024, grid=1024x1 |
| from_rou_evals | prove2 | L | 0.000031 s | l_evals=256, grid=1x256 |
| from_rou_evals | prove4 | K0 | 0.000205 s | k0_evals=1024, grid=1024x1 |
| mul | prove4 | RXY_t_mi | 0.000483 s | t_mi=2048x1 |
| mul | prove4 | RXY_t_smax | 0.000451 s | t_smax=1x512 |
| mul | prove4 | term10 | 0.001648 s | gXY=1024x256 |
| recursion_eval | prove1 | rXY | 0.184311 s | fXY_evals=262144, gXY_evals=262144, grid=1024x256 |
| scale_coeffs | prove2 | r_omegaX | 0.001917 s | rXY=1024x256 |
| scale_coeffs | prove2 | r_omegaX_omegaY | 0.002386 s | r_omegaX=1024x256 |
| scale_coeffs | prove4 | r_omegaX | 0.002222 s | R=1024x256 |
| scale_coeffs | prove4 | r_omegaX_omegaY | 0.008270 s | R_omegaX=1024x256 |
| to_rou_evals | prove1 | fXY | 0.011485 s | fXY=1024x256 |
| to_rou_evals | prove1 | gXY | 0.011295 s | gXY=1024x256 |

## Encode Details (by variable)

| module | variable | time | dims |
| --- | --- | --- | --- |
| init | A_free | 0.001886 s | msm=256x1 |
| prove0 | B | 0.324398 s | msm=1026x258 |
| prove0 | Q_AX | 0.596235 s | msm=1025x511 |
| prove0 | Q_AY | 0.325694 s | msm=1025x257 |
| prove0 | U | 0.335185 s | msm=1025x257 |
| prove0 | V | 0.320594 s | msm=1025x257 |
| prove0 | W | 0.317680 s | msm=1027x259 |
| prove1 | R | 0.360972 s | msm=1025x257 |
| prove2 | Q_CX | 1.116702 s | msm=2048x511 |
| prove2 | Q_CY | 0.611996 s | msm=2047x257 |
| prove4 | M_N_X | 0.336627 s | msm=1024x256 |
| prove4 | M_Y | 0.002260 s | msm=1x256 |
| prove4 | N_Y | 0.001489 s | msm=1x256 |
| prove4 | Pi_X | 1.142646 s | msm=2047x511 |
| prove4 | Pi_Y | 0.002568 s | msm=1x510 |
