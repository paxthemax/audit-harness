// Capture channel: public API.
export { openCaptureChannel, captureText, unitRef, CAPTURE_PURPOSES, type CapturePurpose, type CaptureRequest } from './capture.ts';
export { runCaptureHook, HOOK_CHANNEL_NAME, type HookInput, type CaptureHookOptions } from './hook.ts';
export { runCaptureWrapper, WRAPPER_CHANNEL_NAME, type CaptureWrapperOptions } from './wrapper.ts';
export { captureProgramDigest, captureProgramFiles, screenProgramDigest, programDigest } from './program.ts';
