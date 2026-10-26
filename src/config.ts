// All tunables live here. Later milestones add onset, refractory, finger history,
// videoLagMs and layout validation limits.
export const CONFIG = {
  camera: {
    width: 1280,
    height: 720,
    frameRate: 60,
  },
  hands: {
    wasmPath: "/mediapipe/wasm",
    modelPath: "/mediapipe/hand_landmarker.task",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  },
};
