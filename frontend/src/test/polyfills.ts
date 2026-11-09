// Runs before any test import loads React (setupFiles order). React checks for AnimationEvent once,
// at load: jsdom has none, so React would listen for a vendor-prefixed `webkitAnimationEnd` and never
// see the plain `animationend` a test dispatches.
globalThis.AnimationEvent ??= class AnimationEvent extends Event {} as typeof globalThis.AnimationEvent;
