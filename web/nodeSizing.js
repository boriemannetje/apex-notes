export const NODE_SIZE_LINEAR_CONNECTIONS = 20;
export const NODE_SIZE_LINEAR_TARGET_SCALE = 2.8;
export const NODE_SIZE_MAX_SCALE = 3;
export const NODE_SIZE_TAIL_DECAY = 10;

const LINEAR_SCALE_DELTA = NODE_SIZE_LINEAR_TARGET_SCALE - 1;
const ASYMPTOTIC_GAP_AT_LINEAR_END = NODE_SIZE_MAX_SCALE - NODE_SIZE_LINEAR_TARGET_SCALE;

export function connectionCountToNodeScale(connectionCount) {
  const count = normalizeConnectionCount(connectionCount);

  if (count <= NODE_SIZE_LINEAR_CONNECTIONS) {
    return 1 + (LINEAR_SCALE_DELTA * count) / NODE_SIZE_LINEAR_CONNECTIONS;
  }

  return NODE_SIZE_MAX_SCALE -
    ASYMPTOTIC_GAP_AT_LINEAR_END *
      Math.exp(-(count - NODE_SIZE_LINEAR_CONNECTIONS) / NODE_SIZE_TAIL_DECAY);
}

function normalizeConnectionCount(connectionCount) {
  const count = Number(connectionCount);
  return Number.isFinite(count) && count > 0 ? count : 0;
}
