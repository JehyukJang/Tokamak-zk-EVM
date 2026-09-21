export const FOUNDATION_PACKAGE = '@tokamak-zk-evm/subcircuit-library';
export const DEPENDENT_PACKAGES = Object.freeze([
  '@tokamak-zk-evm/synthesizer-node',
  '@tokamak-zk-evm/synthesizer-web',
  '@tokamak-zk-evm/cli',
  '@tokamak-zk-evm/snark-browser-compat',
]);
export const RELEASE_PACKAGES = Object.freeze([FOUNDATION_PACKAGE, ...DEPENDENT_PACKAGES]);

const PACKAGE_STATES = new Set(['not-checked', 'absent', 'exact', 'mismatch', 'error']);

/**
 * Classifies a release from Git, npm, the production lock, and verified CRS facts.
 * It never treats an unknown or failed external lookup as package absence.
 */
export function classifyReleaseState(input) {
  validateInput(input);

  const packageStates = RELEASE_PACKAGES.map(name => input.packages[name]);
  if (input.eventName === 'push' && input.changeKind === 'unchanged-general') {
    if (
      !packageStates.every(state => state === 'not-checked') ||
      input.productionSnapshot !== 'not-checked' ||
      input.crs !== 'not-checked'
    ) {
      throw new Error('Validation-only integration must not compare changed source with historical npm tarballs.');
    }
    return 'validation-only';
  }
  if (packageStates.includes('not-checked')) {
    throw new Error('Release stages require authoritative exact-version npm facts.');
  }
  if (packageStates.includes('error')) {
    throw new Error('A registry error cannot be classified as an absent package version.');
  }
  if (packageStates.includes('mismatch')) {
    throw new Error('A published package does not match the source-built release identity.');
  }

  const foundation = input.packages[FOUNDATION_PACKAGE];
  const dependents = DEPENDENT_PACKAGES.map(name => input.packages[name]);
  const allAbsent = packageStates.every(state => state === 'absent');
  const allExact = packageStates.every(state => state === 'exact');
  const dependentsAbsent = dependents.every(state => state === 'absent');
  const dependentsReleasable = dependents.every(state => state === 'absent' || state === 'exact');

  if (input.eventName === 'workflow_dispatch') {
    assertCurrentMainDispatch(input);
    if (allExact && input.productionSnapshot === 'genuine' && input.crs === 'verified') {
      return 'complete';
    }
    if (foundation === 'exact' && dependentsAbsent && input.productionSnapshot === 'stale') {
      return input.crs === 'verified' ? 'production-snapshot' : 'waiting-for-crs-snapshot';
    }
    throw new Error('Manual continuation facts do not describe a valid staged release state.');
  }

  if (input.changeKind === 'version-bump') {
    if (allAbsent && input.productionSnapshot === 'stale') return 'foundation-publication';
    if (foundation === 'exact' && dependentsAbsent && input.productionSnapshot === 'stale') {
      return 'waiting-for-crs-snapshot';
    }
    throw new Error('The version transition does not describe a valid foundation stage or rerun.');
  }

  if (input.changeKind === 'snapshot-lock-only') {
    if (
      foundation === 'exact' &&
      dependentsReleasable &&
      input.productionSnapshot === 'genuine' &&
      input.crs === 'verified'
    ) {
      return allExact ? 'complete' : 'dependent-publication';
    }
    throw new Error('The production-snapshot merge does not satisfy dependent publication gates.');
  }

  throw new Error(`Unsupported Git change kind ${JSON.stringify(input.changeKind)}.`);
}

function validateInput(input) {
  if (input === null || typeof input !== 'object') throw new Error('Release-state input must be an object.');
  if (input.eventName !== 'push' && input.eventName !== 'workflow_dispatch') {
    throw new Error(`Unsupported release event ${JSON.stringify(input.eventName)}.`);
  }
  if (input.eventName === 'push' && !input.parentSha) {
    throw new Error('A push release classification requires the first-parent commit.');
  }
  if (!['not-checked', 'genuine', 'stale'].includes(input.productionSnapshot)) {
    throw new Error('Production snapshot state must be not-checked, genuine, or stale.');
  }
  if (!['not-checked', 'verified', 'missing'].includes(input.crs)) {
    throw new Error('CRS state must be not-checked, verified, or missing.');
  }
  if (input.packages === null || typeof input.packages !== 'object') {
    throw new Error('Release package facts are required.');
  }
  for (const name of RELEASE_PACKAGES) {
    if (!PACKAGE_STATES.has(input.packages[name])) {
      throw new Error(`Package ${name} has invalid state ${JSON.stringify(input.packages[name])}.`);
    }
  }
}

function assertCurrentMainDispatch(input) {
  if (input.ref !== 'refs/heads/main') {
    throw new Error(`Manual continuation must select refs/heads/main, found ${JSON.stringify(input.ref)}.`);
  }
  if (!input.currentSha || input.currentSha !== input.mainSha) {
    throw new Error('Manual continuation must resolve to the current main commit.');
  }
}
