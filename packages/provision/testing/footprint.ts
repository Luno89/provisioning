const MB = 1024 ** 2;

export const MEASURED_PEAK = 1_363_702_193;

export const RUN_NEEDS = Math.ceil((MEASURED_PEAK * 1.5) / MB) * MB;
