import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { EvalStandard } from "./types.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STANDARD_PATH = join(
  MODULE_DIR,
  "..",
  "templates",
  "eval-standard.json",
);

let cachedDefaultTemplateText: string | undefined;
let cachedDefaultStandard: EvalStandard | undefined;

function readDefaultStandardTemplateText(): string {
  if (cachedDefaultTemplateText !== undefined) return cachedDefaultTemplateText;
  cachedDefaultTemplateText = readFileSync(DEFAULT_STANDARD_PATH, "utf-8");
  return cachedDefaultTemplateText;
}

function normalizeStandard(
  raw: Partial<EvalStandard>,
  defaultNoiseFilters?: EvalStandard["noiseFilters"],
): EvalStandard {
  if (!raw.name || !Array.isArray(raw.sections) || raw.sections.length === 0) {
    throw new Error(
      "Invalid standard: must have 'name' and at least one entry in 'sections'",
    );
  }

  const warnings: string[] = [];

  const sections = raw.sections.map((sec) => {
    if (!sec.id || !sec.name || !sec.standard || !sec.superior) {
      throw new Error(
        `Invalid section '${sec.id ?? "?"}': must have id, name, standard, superior`,
      );
    }

    const thresholds = sec.thresholds ?? {};
    const thresholdKeys = new Set(Object.keys(thresholds));

    // Validate superiorRules references
    if (sec.superiorRules) {
      const allRefs = [
        ...(sec.superiorRules.strongThresholds ?? []),
        ...(sec.superiorRules.supportThresholds ?? []),
      ];
      for (const ref of allRefs) {
        if (!thresholdKeys.has(ref)) {
          warnings.push(
            `Section '${sec.id}': superiorRules references '${ref}' which is not defined in thresholds. ` +
              `Available keys: [${[...thresholdKeys].join(", ")}]`,
          );
        }
      }
    }

    return {
      ...sec,
      keywords: sec.keywords ?? [],
      thresholds,
      superiorRules: sec.superiorRules,
      weight: sec.weight ?? "",
      standard: {
        ...sec.standard,
        label: sec.standard.label ?? `${sec.standard.score}%`,
      },
      superior: {
        ...sec.superior,
        label: sec.superior.label ?? `${sec.superior.score}%`,
      },
    };
  });

  if (warnings.length > 0) {
    for (const w of warnings) {
      process.stderr.write(`[caliber] WARNING: ${w}\n`);
    }
  }

  const noiseFilters = defaultNoiseFilters
    ? { ...defaultNoiseFilters, ...raw.noiseFilters }
    : raw.noiseFilters;

  return {
    name: raw.name,
    description: raw.description,
    sections,
    noiseFilters,
  };
}

function loadBundledDefaultStandard(): EvalStandard {
  if (cachedDefaultStandard) return cachedDefaultStandard;

  const raw = JSON.parse(
    readDefaultStandardTemplateText(),
  ) as Partial<EvalStandard>;
  cachedDefaultStandard = normalizeStandard(raw);
  return cachedDefaultStandard;
}

// ── Loader ──

export function loadStandard(path?: string): EvalStandard {
  const defaultStandard = loadBundledDefaultStandard();
  if (!path) return defaultStandard;

  try {
    const raw = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as Partial<EvalStandard>;
    return normalizeStandard(raw, defaultStandard.noiseFilters);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error loading standard from ${path}: ${msg}\n`);
    process.stderr.write("Falling back to built-in default standard.\n");
    return defaultStandard;
  }
}

export function getDefaultStandard(): EvalStandard {
  return loadBundledDefaultStandard();
}

export function getDefaultStandardTemplateText(): string {
  return readDefaultStandardTemplateText();
}
