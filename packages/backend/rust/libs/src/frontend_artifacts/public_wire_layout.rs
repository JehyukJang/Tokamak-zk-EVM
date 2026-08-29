use super::{BufferDirection, PlacementVariables, SetupParams, SubcircuitInfo};
use serde_json::from_reader;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs::File;
use std::io::{self, BufReader};
use std::ops::Range;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GlobalWire {
    Padding,
    Mapped {
        subcircuit_id: usize,
        local_wire_index: usize,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PublicWireSegment {
    pub start: usize,
    pub end: usize,
    pub subcircuit_id: usize,
    pub placement_phase: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicWireLayout {
    l_free: usize,
    sources: Box<[GlobalWire]>,
    segments: Box<[PublicWireSegment]>,
    placement_phase_by_subcircuit_id: HashMap<usize, usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicWireLayoutError(String);

impl fmt::Display for PublicWireLayoutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl std::error::Error for PublicWireLayoutError {}

impl PublicWireLayout {
    pub fn read_from_qap_path(qap_path: &Path) -> io::Result<Self> {
        let setup_params = SetupParams::read_from_json(qap_path.join("setupParams.json"))?;
        let subcircuit_infos =
            SubcircuitInfo::read_box_from_json(qap_path.join("subcircuitInfo.json"))?;
        let global_wires = read_global_wires(qap_path.join("globalWireList.json"))?;

        Self::derive(&setup_params, &global_wires, &subcircuit_infos)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    pub fn derive(
        setup_params: &SetupParams,
        global_wires: &[GlobalWire],
        subcircuit_infos: &[SubcircuitInfo],
    ) -> Result<Self, PublicWireLayoutError> {
        validate_dimensions(setup_params, global_wires, subcircuit_infos)?;
        let infos_by_id = index_subcircuits(subcircuit_infos)?;
        validate_global_wire_inverse(global_wires, &infos_by_id)?;
        let placement_phase_by_subcircuit_id =
            derive_buffer_placement_phases(subcircuit_infos, setup_params.s_max)?;

        let mut sources = Vec::with_capacity(setup_params.l);
        let mut segments = Vec::new();
        let mut seen_public_buffers = HashSet::new();
        let mut active_segment: Option<ActiveSegment> = None;

        for (global_wire_index, source) in
            global_wires[..setup_params.l].iter().copied().enumerate()
        {
            match source {
                GlobalWire::Padding => {
                    if global_wire_index >= setup_params.l_free {
                        return Err(error(format!(
                            "public padding at wire {global_wire_index} is outside the free region"
                        )));
                    }
                    finish_segment(
                        &mut active_segment,
                        &mut seen_public_buffers,
                        &mut segments,
                        &placement_phase_by_subcircuit_id,
                    )?;
                    sources.push(GlobalWire::Padding);
                }
                GlobalWire::Mapped {
                    subcircuit_id,
                    local_wire_index,
                } => {
                    let subcircuit = infos_by_id.get(&subcircuit_id).ok_or_else(|| {
                        error(format!(
                            "public wire {global_wire_index} references unknown subcircuit {subcircuit_id}"
                        ))
                    })?;
                    let public_port = public_port(subcircuit)?;

                    if subcircuit.flattenMap.get(local_wire_index) != Some(&global_wire_index) {
                        return Err(error(format!(
                            "global wire {global_wire_index} is not the inverse of subcircuit {subcircuit_id} local wire {local_wire_index}"
                        )));
                    }
                    if !public_port.contains(&local_wire_index) {
                        return Err(error(format!(
                            "global wire {global_wire_index} references non-public local wire {local_wire_index} of buffer {subcircuit_id}"
                        )));
                    }

                    match active_segment.as_mut() {
                        Some(segment) if segment.subcircuit_id == subcircuit_id => {
                            let expected_local_wire_index =
                                segment.public_port.start + (global_wire_index - segment.start);
                            if local_wire_index != expected_local_wire_index {
                                return Err(error(format!(
                                    "public buffer {subcircuit_id} has non-contiguous local wire mapping at global wire {global_wire_index}"
                                )));
                            }
                            segment.end = global_wire_index + 1;
                        }
                        _ => {
                            finish_segment(
                                &mut active_segment,
                                &mut seen_public_buffers,
                                &mut segments,
                                &placement_phase_by_subcircuit_id,
                            )?;
                            if local_wire_index != public_port.start {
                                return Err(error(format!(
                                    "public buffer {subcircuit_id} starts at local wire {local_wire_index}, expected {}",
                                    public_port.start
                                )));
                            }
                            active_segment = Some(ActiveSegment {
                                start: global_wire_index,
                                end: global_wire_index + 1,
                                subcircuit_id,
                                public_port,
                            });
                        }
                    }
                    sources.push(source);
                }
            }
        }
        finish_segment(
            &mut active_segment,
            &mut seen_public_buffers,
            &mut segments,
            &placement_phase_by_subcircuit_id,
        )?;

        Ok(Self {
            l_free: setup_params.l_free,
            sources: sources.into_boxed_slice(),
            segments: segments.into_boxed_slice(),
            placement_phase_by_subcircuit_id,
        })
    }

    pub fn len(&self) -> usize {
        self.sources.len()
    }

    pub fn free_public_len(&self) -> usize {
        self.l_free
    }

    pub fn is_free_public_index(&self, global_wire_index: usize) -> bool {
        global_wire_index < self.l_free && global_wire_index < self.sources.len()
    }

    pub fn source_for_public_wire(&self, global_wire_index: usize) -> Option<GlobalWire> {
        self.sources.get(global_wire_index).copied()
    }

    pub fn placement_phase_for_public_wire(&self, global_wire_index: usize) -> Option<usize> {
        match self.source_for_public_wire(global_wire_index)? {
            GlobalWire::Padding => None,
            GlobalWire::Mapped { subcircuit_id, .. } => {
                self.placement_phase_for_subcircuit(subcircuit_id)
            }
        }
    }

    pub fn placement_phase_for_subcircuit(&self, subcircuit_id: usize) -> Option<usize> {
        self.placement_phase_by_subcircuit_id
            .get(&subcircuit_id)
            .copied()
    }

    pub fn segments(&self) -> &[PublicWireSegment] {
        &self.segments
    }

    pub fn validate_runtime_public_buffer_placements(
        &self,
        placement_variables: &[PlacementVariables],
    ) -> Result<(), PublicWireLayoutError> {
        let public_buffer_ids = self
            .segments()
            .iter()
            .map(|segment| segment.subcircuit_id)
            .collect::<HashSet<_>>();
        let mut runtime_placement_by_subcircuit_id = HashMap::new();

        for (placement_phase, placement) in placement_variables.iter().enumerate() {
            if !public_buffer_ids.contains(&placement.subcircuitId) {
                continue;
            }
            if let Some(previous_phase) =
                runtime_placement_by_subcircuit_id.insert(placement.subcircuitId, placement_phase)
            {
                return Err(error(format!(
                    "public buffer {} appears at runtime placement phases {previous_phase} and {placement_phase}",
                    placement.subcircuitId
                )));
            }
        }

        for segment in self.segments() {
            let runtime_phase = runtime_placement_by_subcircuit_id
                .get(&segment.subcircuit_id)
                .copied()
                .ok_or_else(|| {
                    error(format!(
                        "public buffer {} has no runtime placement",
                        segment.subcircuit_id
                    ))
                })?;
            if runtime_phase != segment.placement_phase {
                return Err(error(format!(
                    "public buffer {} is at runtime placement phase {runtime_phase}, expected {}",
                    segment.subcircuit_id, segment.placement_phase
                )));
            }
        }
        Ok(())
    }
}

pub fn read_global_wires(path: impl AsRef<Path>) -> io::Result<Box<[GlobalWire]>> {
    let file = File::open(path)?;
    let encoded_wires: Vec<[i64; 2]> = from_reader(BufReader::new(file))?;

    encoded_wires
        .into_iter()
        .enumerate()
        .map(|(index, [subcircuit_id, local_wire_index])| {
            if [subcircuit_id, local_wire_index] == [-1, -1] {
                return Ok(GlobalWire::Padding);
            }
            if subcircuit_id < 0 || local_wire_index < 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("globalWireList[{index}] has a partially negative mapping"),
                ));
            }
            let subcircuit_id = usize::try_from(subcircuit_id).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("globalWireList[{index}] subcircuit id is out of range"),
                )
            })?;
            let local_wire_index = usize::try_from(local_wire_index).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("globalWireList[{index}] local wire index is out of range"),
                )
            })?;
            Ok(GlobalWire::Mapped {
                subcircuit_id,
                local_wire_index,
            })
        })
        .collect::<io::Result<Vec<_>>>()
        .map(Vec::into_boxed_slice)
}

struct ActiveSegment {
    start: usize,
    end: usize,
    subcircuit_id: usize,
    public_port: Range<usize>,
}

fn validate_dimensions(
    setup_params: &SetupParams,
    global_wires: &[GlobalWire],
    subcircuit_infos: &[SubcircuitInfo],
) -> Result<(), PublicWireLayoutError> {
    if setup_params.l_free > setup_params.l {
        return Err(error("l_free must not exceed l"));
    }
    if setup_params.l > setup_params.l_D || setup_params.l_D > setup_params.m_D {
        return Err(error("setup public and interface boundaries are invalid"));
    }
    if global_wires.len() != setup_params.m_D {
        return Err(error(format!(
            "globalWireList has {} entries, expected m_D {}",
            global_wires.len(),
            setup_params.m_D
        )));
    }
    if subcircuit_infos.len() != setup_params.s_D {
        return Err(error(format!(
            "subcircuitInfo has {} entries, expected s_D {}",
            subcircuit_infos.len(),
            setup_params.s_D
        )));
    }
    Ok(())
}

fn index_subcircuits(
    subcircuit_infos: &[SubcircuitInfo],
) -> Result<HashMap<usize, &SubcircuitInfo>, PublicWireLayoutError> {
    let mut infos_by_id = HashMap::with_capacity(subcircuit_infos.len());
    for subcircuit in subcircuit_infos {
        if infos_by_id.insert(subcircuit.id, subcircuit).is_some() {
            return Err(error(format!(
                "subcircuitInfo contains duplicate id {}",
                subcircuit.id
            )));
        }
    }
    Ok(infos_by_id)
}

fn derive_buffer_placement_phases(
    subcircuit_infos: &[SubcircuitInfo],
    s_max: usize,
) -> Result<HashMap<usize, usize>, PublicWireLayoutError> {
    let buffer_ids = subcircuit_infos
        .iter()
        .filter(|subcircuit| subcircuit.bufferDirection.is_some())
        .map(|subcircuit| subcircuit.id)
        .collect::<HashSet<_>>();

    if buffer_ids.is_empty() {
        return Err(error("subcircuitInfo does not declare any buffers"));
    }
    let mut placement_phase_by_subcircuit_id = HashMap::with_capacity(buffer_ids.len());
    for placement_phase in 0..buffer_ids.len() {
        if placement_phase >= s_max {
            return Err(error(format!(
                "buffer placement phase {placement_phase} is outside s_max {s_max}"
            )));
        }
        if !buffer_ids.contains(&placement_phase) {
            return Err(error(format!(
                "public buffer IDs must form the contiguous placement prefix 0..{}",
                buffer_ids.len() - 1
            )));
        }
        placement_phase_by_subcircuit_id.insert(placement_phase, placement_phase);
    }
    Ok(placement_phase_by_subcircuit_id)
}

fn validate_global_wire_inverse(
    global_wires: &[GlobalWire],
    infos_by_id: &HashMap<usize, &SubcircuitInfo>,
) -> Result<(), PublicWireLayoutError> {
    for (global_wire_index, source) in global_wires.iter().copied().enumerate() {
        let GlobalWire::Mapped {
            subcircuit_id,
            local_wire_index,
        } = source
        else {
            continue;
        };
        let subcircuit = infos_by_id.get(&subcircuit_id).ok_or_else(|| {
            error(format!(
                "global wire {global_wire_index} references unknown subcircuit {subcircuit_id}"
            ))
        })?;
        if subcircuit.flattenMap.get(local_wire_index) != Some(&global_wire_index) {
            return Err(error(format!(
                "global wire {global_wire_index} is not the inverse of subcircuit {subcircuit_id} local wire {local_wire_index}"
            )));
        }
    }

    for subcircuit in infos_by_id.values() {
        if subcircuit.flattenMap.len() != subcircuit.Nwires {
            return Err(error(format!(
                "subcircuit {} flattenMap has {} entries, expected {}",
                subcircuit.id,
                subcircuit.flattenMap.len(),
                subcircuit.Nwires
            )));
        }
        for (local_wire_index, global_wire_index) in
            subcircuit.flattenMap.iter().copied().enumerate()
        {
            let source = global_wires.get(global_wire_index).ok_or_else(|| {
                error(format!(
                    "subcircuit {} local wire {local_wire_index} maps outside globalWireList",
                    subcircuit.id
                ))
            })?;
            if *source
                != (GlobalWire::Mapped {
                    subcircuit_id: subcircuit.id,
                    local_wire_index,
                })
            {
                return Err(error(format!(
                    "subcircuit {} local wire {local_wire_index} is not the inverse of global wire {global_wire_index}",
                    subcircuit.id
                )));
            }
        }
    }
    Ok(())
}

fn public_port(subcircuit: &SubcircuitInfo) -> Result<Range<usize>, PublicWireLayoutError> {
    let direction = subcircuit.bufferDirection.ok_or_else(|| {
        error(format!(
            "public wire references non-buffer subcircuit {}",
            subcircuit.id
        ))
    })?;
    let encoded_range = match direction {
        BufferDirection::In => &subcircuit.In_idx,
        BufferDirection::Out => &subcircuit.Out_idx,
    };
    if encoded_range.len() != 2 {
        return Err(error(format!(
            "buffer {} has an invalid public port range",
            subcircuit.id
        )));
    }
    let start = encoded_range[0];
    let count = encoded_range[1];
    let end = start.checked_add(count).ok_or_else(|| {
        error(format!(
            "buffer {} public port range overflows",
            subcircuit.id
        ))
    })?;
    if start == 0 || end > subcircuit.Nwires {
        return Err(error(format!(
            "buffer {} has an invalid public port range",
            subcircuit.id
        )));
    }
    Ok(start..end)
}

fn finish_segment(
    active_segment: &mut Option<ActiveSegment>,
    seen_public_buffers: &mut HashSet<usize>,
    segments: &mut Vec<PublicWireSegment>,
    placement_phase_by_subcircuit_id: &HashMap<usize, usize>,
) -> Result<(), PublicWireLayoutError> {
    let Some(segment) = active_segment.take() else {
        return Ok(());
    };
    if !seen_public_buffers.insert(segment.subcircuit_id) {
        return Err(error(format!(
            "public buffer {} appears in more than one global-wire run",
            segment.subcircuit_id
        )));
    }
    if segment.end - segment.start != segment.public_port.len() {
        return Err(error(format!(
            "public buffer {} maps {} wires, expected {}",
            segment.subcircuit_id,
            segment.end - segment.start,
            segment.public_port.len()
        )));
    }
    segments.push(PublicWireSegment {
        start: segment.start,
        end: segment.end,
        subcircuit_id: segment.subcircuit_id,
        placement_phase: placement_phase_by_subcircuit_id
            .get(&segment.subcircuit_id)
            .copied()
            .ok_or_else(|| {
                error(format!(
                    "public buffer {} has no placement phase",
                    segment.subcircuit_id
                ))
            })?,
    });
    Ok(())
}

fn error(message: impl Into<String>) -> PublicWireLayoutError {
    PublicWireLayoutError(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const L_FREE: usize = 256;
    const L: usize = 396;

    #[test]
    fn derives_each_public_buffer_phase_and_padding_from_existing_artifacts() {
        let (setup_params, global_wires, subcircuits) = six_public_buffer_artifacts();

        let layout = PublicWireLayout::derive(&setup_params, &global_wires, &subcircuits).unwrap();

        assert_eq!(layout.len(), L);
        assert_eq!(layout.placement_phase_for_public_wire(0), Some(0));
        assert_eq!(layout.placement_phase_for_public_wire(50), Some(1));
        assert_eq!(layout.placement_phase_for_public_wire(80), Some(2));
        assert_eq!(layout.placement_phase_for_public_wire(130), Some(3));
        assert_eq!(layout.placement_phase_for_public_wire(134), Some(4));
        assert_eq!(layout.placement_phase_for_public_wire(158), None);
        assert_eq!(layout.placement_phase_for_public_wire(256), Some(5));
        assert!(layout.is_free_public_index(255));
        assert!(!layout.is_free_public_index(256));
        assert_eq!(
            layout.segments(),
            &[
                segment(0, 50, 0, 0),
                segment(50, 80, 1, 1),
                segment(80, 130, 2, 2),
                segment(130, 134, 3, 3),
                segment(134, 158, 4, 4),
                segment(256, 396, 5, 5),
            ]
        );
    }

    #[test]
    fn rejects_padding_outside_the_free_public_region() {
        let (mut setup_params, mut global_wires, mut subcircuits) = six_public_buffer_artifacts();
        setup_params.l = L + 1;
        setup_params.l_D = L + 1;
        let displaced_source = global_wires[L];
        let GlobalWire::Mapped {
            subcircuit_id,
            local_wire_index,
        } = displaced_source
        else {
            panic!("test fixture must map the first internal wire");
        };
        subcircuits[subcircuit_id].flattenMap[local_wire_index] = global_wires.len();
        global_wires[L] = GlobalWire::Padding;
        global_wires.push(displaced_source);
        setup_params.m_D = global_wires.len();

        assert_error(
            PublicWireLayout::derive(&setup_params, &global_wires, &subcircuits),
            "outside the free region",
        );
    }

    #[test]
    fn rejects_non_inverse_global_wire_mappings() {
        let (setup_params, mut global_wires, subcircuits) = six_public_buffer_artifacts();
        global_wires[50] = GlobalWire::Mapped {
            subcircuit_id: 1,
            local_wire_index: 2,
        };

        assert_error(
            PublicWireLayout::derive(&setup_params, &global_wires, &subcircuits),
            "not the inverse",
        );
    }

    #[test]
    fn rejects_non_contiguous_public_buffer_runs() {
        let mut subcircuit = buffer(0, BufferDirection::Out, 3);
        subcircuit.flattenMap[1] = 0;
        subcircuit.flattenMap[3] = 1;
        let mut global_wires = vec![
            GlobalWire::Mapped {
                subcircuit_id: 0,
                local_wire_index: 1,
            },
            GlobalWire::Mapped {
                subcircuit_id: 0,
                local_wire_index: 3,
            },
        ];
        populate_remaining_global_wires(&mut global_wires, std::slice::from_mut(&mut subcircuit));
        let setup_params = SetupParams {
            l_free: 2,
            l: 2,
            l_user_out: 0,
            l_user: 0,
            l_D: global_wires.len(),
            m_D: global_wires.len(),
            n: 1,
            s_D: 1,
            s_max: 1,
        };

        assert_error(
            PublicWireLayout::derive(&setup_params, &global_wires, &[subcircuit]),
            "non-contiguous",
        );
    }

    #[test]
    fn rejects_invalid_public_port_ranges() {
        let (setup_params, global_wires, mut subcircuits) = six_public_buffer_artifacts();
        subcircuits[0].Out_idx = vec![0, 50].into_boxed_slice();

        assert_error(
            PublicWireLayout::derive(&setup_params, &global_wires, &subcircuits),
            "invalid public port range",
        );
    }

    #[test]
    fn rejects_gapped_public_buffer_ids() {
        let (setup_params, mut global_wires, mut subcircuits) = six_public_buffer_artifacts();
        subcircuits[2].id = 17;
        for source in &mut global_wires {
            if let GlobalWire::Mapped {
                subcircuit_id,
                local_wire_index: _,
            } = source
            {
                if *subcircuit_id == 2 {
                    *subcircuit_id = 17;
                }
            }
        }

        assert_error(
            PublicWireLayout::derive(&setup_params, &global_wires, &subcircuits),
            "contiguous placement prefix",
        );
    }

    #[test]
    fn derives_phase_when_the_public_buffer_count_increases() {
        let (mut setup_params, _, mut subcircuits) = six_public_buffer_artifacts();
        let public_ranges = [
            (0, 50, 0),
            (50, 80, 1),
            (80, 130, 2),
            (130, 134, 3),
            (134, 158, 4),
            (158, 208, 6),
            (256, 396, 5),
        ];
        let global_wires = rebuild_global_wires(&mut subcircuits, L, &public_ranges);
        setup_params.m_D = global_wires.len();

        let layout = PublicWireLayout::derive(&setup_params, &global_wires, &subcircuits).unwrap();
        assert_eq!(layout.placement_phase_for_public_wire(158), Some(6));
        assert_eq!(layout.placement_phase_for_subcircuit(6), Some(6));
        assert!(layout.segments().contains(&segment(158, 208, 6, 6)));

        let placements = (0..=6)
            .map(|subcircuit_id| PlacementVariables {
                subcircuitId: subcircuit_id,
                variables: Box::new([]),
            })
            .collect::<Vec<_>>();
        layout
            .validate_runtime_public_buffer_placements(&placements)
            .unwrap();
    }

    #[test]
    fn ignores_reordered_non_buffer_subcircuits_when_deriving_phases() {
        let (mut setup_params, mut global_wires, mut subcircuits) = six_public_buffer_artifacts();
        subcircuits.insert(1, ordinary_subcircuit(19));
        subcircuits.insert(5, ordinary_subcircuit(17));
        populate_remaining_global_wires(&mut global_wires, &mut subcircuits);
        setup_params.m_D = global_wires.len();
        setup_params.s_D = subcircuits.len();

        let layout = PublicWireLayout::derive(&setup_params, &global_wires, &subcircuits).unwrap();
        assert_eq!(layout.placement_phase_for_subcircuit(0), Some(0));
        assert_eq!(layout.placement_phase_for_subcircuit(1), Some(1));
        assert_eq!(layout.placement_phase_for_subcircuit(2), Some(2));
        assert_eq!(layout.placement_phase_for_subcircuit(5), Some(5));

        let placements = (0..6)
            .map(|subcircuit_id| PlacementVariables {
                subcircuitId: subcircuit_id,
                variables: Box::new([]),
            })
            .chain(
                [19, 17]
                    .into_iter()
                    .map(|subcircuit_id| PlacementVariables {
                        subcircuitId: subcircuit_id,
                        variables: Box::new([]),
                    }),
            )
            .collect::<Vec<_>>();
        layout
            .validate_runtime_public_buffer_placements(&placements)
            .unwrap();
    }

    #[test]
    fn rejects_a_public_phase_outside_the_placement_domain() {
        let (mut setup_params, global_wires, subcircuits) = six_public_buffer_artifacts();
        setup_params.s_max = 5;

        assert_error(
            PublicWireLayout::derive(&setup_params, &global_wires, &subcircuits),
            "outside s_max",
        );
    }

    #[test]
    fn validates_runtime_public_buffer_placement_phases() {
        let (setup_params, global_wires, subcircuits) = six_public_buffer_artifacts();
        let layout = PublicWireLayout::derive(&setup_params, &global_wires, &subcircuits).unwrap();
        let mut placements = (0..6)
            .map(|subcircuit_id| PlacementVariables {
                subcircuitId: subcircuit_id,
                variables: Box::new([]),
            })
            .collect::<Vec<_>>();

        layout
            .validate_runtime_public_buffer_placements(&placements)
            .unwrap();

        placements[4].subcircuitId = 5;
        placements[5].subcircuitId = 4;
        let error = layout
            .validate_runtime_public_buffer_placements(&placements)
            .unwrap_err();
        assert!(error.to_string().contains("expected 4"));

        placements[4].subcircuitId = 4;
        placements[5].subcircuitId = 5;
        placements.push(PlacementVariables {
            subcircuitId: 2,
            variables: Box::new([]),
        });
        let error = layout
            .validate_runtime_public_buffer_placements(&placements)
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("appears at runtime placement phases"));
    }

    fn assert_error(
        result: Result<PublicWireLayout, PublicWireLayoutError>,
        expected_message: &str,
    ) {
        let error = result.unwrap_err();
        assert!(
            error.to_string().contains(expected_message),
            "expected error containing '{expected_message}', got '{error}'"
        );
    }

    fn six_public_buffer_artifacts() -> (SetupParams, Vec<GlobalWire>, Vec<SubcircuitInfo>) {
        let buffer_specs = [
            (BufferDirection::Out, 50),
            (BufferDirection::Out, 30),
            (BufferDirection::Out, 50),
            (BufferDirection::In, 4),
            (BufferDirection::In, 24),
            (BufferDirection::In, 140),
            (BufferDirection::In, 50),
        ];
        let mut subcircuits = buffer_specs
            .into_iter()
            .enumerate()
            .map(|(id, (direction, capacity))| buffer(id, direction, capacity))
            .collect::<Vec<_>>();
        let mut global_wires = vec![GlobalWire::Padding; L];
        let public_ranges = [
            (0, 50, 0),
            (50, 80, 1),
            (80, 130, 2),
            (130, 134, 3),
            (134, 158, 4),
            (256, 396, 5),
        ];
        for (start, end, subcircuit_id) in public_ranges {
            map_public_range(
                &mut global_wires,
                &mut subcircuits[subcircuit_id],
                start,
                end,
            );
        }
        populate_remaining_global_wires(&mut global_wires, &mut subcircuits);

        (
            SetupParams {
                l_free: L_FREE,
                l: L,
                l_user_out: 130,
                l_user: 134,
                l_D: L,
                m_D: global_wires.len(),
                n: 1,
                s_D: subcircuits.len(),
                s_max: 8,
            },
            global_wires,
            subcircuits,
        )
    }

    fn buffer(id: usize, direction: BufferDirection, capacity: usize) -> SubcircuitInfo {
        let n_wires = capacity * 2 + 1;
        SubcircuitInfo {
            id,
            name: format!("buffer{id}"),
            Nwires: n_wires,
            Nconsts: 0,
            Out_idx: vec![1, capacity].into_boxed_slice(),
            In_idx: vec![capacity + 1, capacity].into_boxed_slice(),
            flattenMap: vec![usize::MAX; n_wires].into_boxed_slice(),
            bufferDirection: Some(direction),
        }
    }

    fn ordinary_subcircuit(id: usize) -> SubcircuitInfo {
        SubcircuitInfo {
            id,
            name: format!("ordinary{id}"),
            Nwires: 1,
            Nconsts: 0,
            Out_idx: Box::new([]),
            In_idx: Box::new([]),
            flattenMap: vec![usize::MAX].into_boxed_slice(),
            bufferDirection: None,
        }
    }

    fn map_public_range(
        global_wires: &mut [GlobalWire],
        subcircuit: &mut SubcircuitInfo,
        start: usize,
        end: usize,
    ) {
        let public_port = public_port(subcircuit).expect("fixture must define a public buffer");
        assert_eq!(
            end - start,
            public_port.end - public_port.start,
            "fixture public range must match the buffer capacity"
        );
        for (offset, global_wire_index) in (start..end).enumerate() {
            let local_wire_index = public_port.start + offset;
            subcircuit.flattenMap[local_wire_index] = global_wire_index;
            global_wires[global_wire_index] = GlobalWire::Mapped {
                subcircuit_id: subcircuit.id,
                local_wire_index,
            };
        }
    }

    fn rebuild_global_wires(
        subcircuits: &mut [SubcircuitInfo],
        public_wire_count: usize,
        public_ranges: &[(usize, usize, usize)],
    ) -> Vec<GlobalWire> {
        for subcircuit in subcircuits.iter_mut() {
            subcircuit.flattenMap.fill(usize::MAX);
        }
        let mut global_wires = vec![GlobalWire::Padding; public_wire_count];
        for &(start, end, subcircuit_id) in public_ranges {
            let subcircuit = subcircuits
                .iter_mut()
                .find(|subcircuit| subcircuit.id == subcircuit_id)
                .expect("fixture range must reference a known subcircuit");
            map_public_range(&mut global_wires, subcircuit, start, end);
        }
        populate_remaining_global_wires(&mut global_wires, subcircuits);
        global_wires
    }

    fn segment(
        start: usize,
        end: usize,
        subcircuit_id: usize,
        placement_phase: usize,
    ) -> PublicWireSegment {
        PublicWireSegment {
            start,
            end,
            subcircuit_id,
            placement_phase,
        }
    }

    fn populate_remaining_global_wires(
        global_wires: &mut Vec<GlobalWire>,
        subcircuits: &mut [SubcircuitInfo],
    ) {
        for subcircuit in subcircuits {
            for (local_wire_index, global_wire_index) in
                subcircuit.flattenMap.iter_mut().enumerate()
            {
                if *global_wire_index != usize::MAX {
                    continue;
                }
                let next_global_wire_index = global_wires.len();
                *global_wire_index = next_global_wire_index;
                global_wires.push(GlobalWire::Mapped {
                    subcircuit_id: subcircuit.id,
                    local_wire_index,
                });
            }
        }
    }
}
