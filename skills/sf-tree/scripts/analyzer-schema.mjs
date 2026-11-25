// Strict <system_state> extraction and schema validation for Software Factory pipeline stages.
// Node 20+ built-ins only.

export const REQUIRED_KEYS = Object.freeze({
  vision: [
    "phase",
    "project_name",
    "primary_user",
    "ux_tone",
    "hard_constraints",
    "explicitly_out_of_scope",
  ],
  "market-research": [
    "phase",
    "competitors",
    "market_gap_defined",
    "validation_status",
    "identified_risks",
  ],
  brd: [
    "phase",
    "monetization_model",
    "core_kpis",
    "compliance_requirements",
    "budget_or_timeline_constraints",
  ],
  prd: [
    "phase",
    "core_flows",
    "business_rules",
    "required_integrations",
    "edge_case_mitigations",
  ],
  ux: [
    "phase",
    "screens_required",
    "primary_navigation_pattern",
    "key_interactions",
    "accessibility_requirements",
  ],
  ui: [
    "phase",
    "css_framework_recommendation",
    "color_palette",
    "typography",
    "border_radius_base",
  ],
  mockery: [
    "phase",
    "fidelity",
    "mockups_dir",
    "devices",
    "sections",
    "screens",
    "components",
    "edges_count",
    "tokens_synced_from_ui",
  ],
  architecture: [
    "phase",
    "frontend_stack",
    "backend_stack",
    "database_type",
    "data_models",
    "core_endpoints",
  ],
  specs: [
    "phase",
    "openapi_stubs",
    "required_unit_tests",
    "required_e2e_tests",
    "linter_rules",
  ],
  review: [
    "phase",
    "source_phases",
    "target_phase",
    "verdict",
    "critical_violations_count",
    "scope_creep_warnings_count",
    "blocking_issues",
  ],
});

const VALID_STAGE_PHASES = new Set([
  "vision",
  "market-research",
  "brd",
  "prd",
  "ux",
  "ui",
  "mockery",
  "architecture",
  "specs",
]);

const VALID_MARKET_VALIDATION_STATUS = new Set(["Proceed", "Pivot Required"]);
const VALID_MOCKERY_FIDELITY = new Set(["wireframe", "styled"]);
const VALID_MOCKERY_DEVICES = new Set(["phone", "tablet", "pos", "desktop", "none"]);
const VALID_MOCKERY_VARIANTS = new Set(["happy", "empty", "loading", "error"]);
const VALID_REVIEW_VERDICTS = new Set(["PASS", "FAIL"]);

const OPEN_TAG = "<system_state>";
const CLOSE_TAG = "</system_state>";

function isPlainObject(val) {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function isNonEmptyString(val) {
  return typeof val === "string" && val.trim().length > 0;
}

function validateNonEmptyString(errors, obj, key, label = key) {
  if (!isNonEmptyString(obj[key])) {
    errors.push(`"${label}" must be a non-empty string`);
    return false;
  }
  return true;
}

function validateStringArray(
  errors,
  obj,
  key,
  { minLength = 0, label = key, allowedValues = null } = {}
) {
  const val = obj[key];
  if (!Array.isArray(val)) {
    errors.push(`"${label}" must be an array of strings`);
    return false;
  }
  if (val.length < minLength) {
    errors.push(
      `"${label}" must contain at least ${minLength} item${minLength === 1 ? "" : "s"}`
    );
  }
  for (let i = 0; i < val.length; i += 1) {
    if (!isNonEmptyString(val[i])) {
      errors.push(`"${label}[${i}]" must be a non-empty string`);
    } else if (allowedValues && !allowedValues.has(val[i])) {
      errors.push(
        `"${label}[${i}]" has invalid value ${JSON.stringify(val[i])} (expected one of: ${[...allowedValues].join(", ")})`
      );
    }
  }
  return true;
}

function validateNonNegInteger(errors, obj, key, label = key) {
  const val = obj[key];
  if (typeof val !== "number" || !Number.isFinite(val) || !Number.isInteger(val) || val < 0) {
    errors.push(`"${label}" must be a finite non-negative integer`);
    return false;
  }
  return true;
}

/**
 * Scan markdown for the trailing `<system_state>...</system_state>` block without
 * truncating prematurely when `</system_state>` appears inside a JSON string literal.
 */
function findLastSystemStateBlock(source) {
  const lower = source.toLowerCase();
  const openLen = OPEN_TAG.length;
  const closeLen = CLOSE_TAG.length;

  let lastMatch = null;
  let searchPos = 0;

  while (searchPos < source.length) {
    const openIdx = lower.indexOf(OPEN_TAG, searchPos);
    if (openIdx === -1) break;

    let currentOpen = openIdx;
    let bodyStart = currentOpen + openLen;
    let i = bodyStart;
    let inString = false;
    let escaped = false;
    let matchedClose = -1;

    while (i < source.length) {
      const ch = source[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        i += 1;
        continue;
      }

      if (ch === '"') {
        inString = true;
        i += 1;
        continue;
      }

      if (ch === "<") {
        if (lower.startsWith(CLOSE_TAG, i)) {
          matchedClose = i;
          break;
        }
        if (lower.startsWith(OPEN_TAG, i)) {
          // Earlier `<system_state>` was an unclosed prose mention; restart at this one.
          currentOpen = i;
          bodyStart = currentOpen + openLen;
          i = bodyStart;
          continue;
        }
      }

      i += 1;
    }

    if (matchedClose === -1) {
      // Fallback for malformed JSON with an unterminated string literal: locate a
      // closing tag directly so malformed blocks still report an invalid JSON error.
      const nextOpen = lower.indexOf(OPEN_TAG, bodyStart);
      const rawClose = lower.indexOf(CLOSE_TAG, bodyStart);
      if (rawClose !== -1 && (nextOpen === -1 || rawClose < nextOpen)) {
        matchedClose = rawClose;
      } else if (nextOpen !== -1) {
        searchPos = nextOpen;
        continue;
      } else {
        break;
      }
    }

    lastMatch = {
      start: currentOpen,
      bodyStart,
      bodyEnd: matchedClose,
      end: matchedClose + closeLen,
    };
    searchPos = matchedClose + closeLen;
  }

  return lastMatch;
}

/**
 * Extract the trailing `<system_state>...</system_state>` JSON block and narrative markdown.
 */
export function extractSystemState(markdown) {
  const source = typeof markdown === "string" ? markdown : "";
  const match = findLastSystemStateBlock(source);

  if (!match) {
    return {
      found: false,
      raw: null,
      state: null,
      narrative: source.trim(),
      error: "Missing <system_state>...</system_state> block",
    };
  }

  const raw = source.slice(match.bodyStart, match.bodyEnd).trim();
  const narrative = (source.slice(0, match.start) + source.slice(match.end)).trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      found: true,
      raw,
      state: null,
      narrative,
      error: `Invalid JSON in <system_state>: ${err.message}`,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      found: true,
      raw,
      state: null,
      narrative,
      error: "<system_state> JSON must be an object",
    };
  }

  return {
    found: true,
    raw,
    state: parsed,
    narrative,
    error: null,
  };
}

/**
 * Strictly validate a parsed `<system_state>` object against the phase schema defined in SKILL.md.
 * All type, enum, nested-field, cardinality, and invariant violations are hard invalid errors.
 */
export function validateSystemState(state, expectedPhase, parseError = null) {
  const errors = [];
  if (parseError) {
    errors.push(parseError);
    return { valid: false, errors };
  }
  if (!isPlainObject(state)) {
    errors.push("Missing or invalid <system_state> object");
    return { valid: false, errors };
  }

  if (state.phase !== expectedPhase) {
    errors.push(
      `Expected phase "${expectedPhase}", got ${JSON.stringify(state.phase)}`
    );
  }

  const requiredKeys = REQUIRED_KEYS[expectedPhase] || [];
  const missingSet = new Set();
  for (const key of requiredKeys) {
    if (
      !Object.prototype.hasOwnProperty.call(state, key) ||
      state[key] === undefined ||
      state[key] === null
    ) {
      errors.push(`Missing required key "${key}"`);
      missingSet.add(key);
    }
  }

  const has = (k) => !missingSet.has(k);

  switch (expectedPhase) {
    case "vision": {
      if (has("project_name")) validateNonEmptyString(errors, state, "project_name");
      if (has("primary_user")) validateNonEmptyString(errors, state, "primary_user");
      if (has("ux_tone")) validateNonEmptyString(errors, state, "ux_tone");
      if (has("hard_constraints")) {
        validateStringArray(errors, state, "hard_constraints", { minLength: 1 });
      }
      if (has("explicitly_out_of_scope")) {
        validateStringArray(errors, state, "explicitly_out_of_scope", { minLength: 1 });
      }
      break;
    }

    case "market-research": {
      if (has("competitors")) {
        if (!Array.isArray(state.competitors)) {
          errors.push(`"competitors" must be an array of { name, weakness, pricing_model } objects`);
        } else {
          if (state.competitors.length < 1) {
            errors.push(`"competitors" must contain at least 1 competitor object`);
          }
          state.competitors.forEach((comp, idx) => {
            if (!isPlainObject(comp)) {
              errors.push(`"competitors[${idx}]" must be an object with name, weakness, and pricing_model`);
              return;
            }
            validateNonEmptyString(errors, comp, "name", `competitors[${idx}].name`);
            validateNonEmptyString(errors, comp, "weakness", `competitors[${idx}].weakness`);
            validateNonEmptyString(errors, comp, "pricing_model", `competitors[${idx}].pricing_model`);
          });
        }
      }
      if (has("market_gap_defined")) validateNonEmptyString(errors, state, "market_gap_defined");
      if (has("validation_status")) {
        if (!VALID_MARKET_VALIDATION_STATUS.has(state.validation_status)) {
          errors.push(
            `Invalid validation_status ${JSON.stringify(state.validation_status)} (expected "Proceed" or "Pivot Required")`
          );
        }
      }
      if (has("identified_risks")) {
        validateStringArray(errors, state, "identified_risks", { minLength: 1 });
      }
      break;
    }

    case "brd": {
      if (has("monetization_model")) validateNonEmptyString(errors, state, "monetization_model");
      if (has("core_kpis")) {
        validateStringArray(errors, state, "core_kpis", { minLength: 1 });
      }
      if (has("compliance_requirements")) {
        validateStringArray(errors, state, "compliance_requirements", { minLength: 0 });
      }
      if (has("budget_or_timeline_constraints")) {
        validateStringArray(errors, state, "budget_or_timeline_constraints", { minLength: 1 });
      }
      break;
    }

    case "prd": {
      if (has("core_flows")) {
        validateStringArray(errors, state, "core_flows", { minLength: 1 });
      }
      if (has("business_rules")) {
        validateStringArray(errors, state, "business_rules", { minLength: 1 });
      }
      if (has("required_integrations")) {
        validateStringArray(errors, state, "required_integrations", { minLength: 0 });
      }
      if (has("edge_case_mitigations")) {
        validateStringArray(errors, state, "edge_case_mitigations", { minLength: 3 });
      }
      break;
    }

    case "ux": {
      if (has("screens_required")) {
        validateStringArray(errors, state, "screens_required", { minLength: 1 });
      }
      if (has("primary_navigation_pattern")) {
        validateNonEmptyString(errors, state, "primary_navigation_pattern");
      }
      if (has("key_interactions")) {
        if (!Array.isArray(state.key_interactions)) {
          errors.push(`"key_interactions" must be an array of { trigger, action } objects`);
        } else {
          if (state.key_interactions.length < 1) {
            errors.push(`"key_interactions" must contain at least 1 interaction object`);
          }
          state.key_interactions.forEach((inter, idx) => {
            if (!isPlainObject(inter)) {
              errors.push(`"key_interactions[${idx}]" must be an object with trigger and action`);
              return;
            }
            validateNonEmptyString(errors, inter, "trigger", `key_interactions[${idx}].trigger`);
            validateNonEmptyString(errors, inter, "action", `key_interactions[${idx}].action`);
          });
        }
      }
      if (has("accessibility_requirements")) {
        validateStringArray(errors, state, "accessibility_requirements", { minLength: 1 });
      }
      break;
    }

    case "ui": {
      if (has("css_framework_recommendation")) {
        validateNonEmptyString(errors, state, "css_framework_recommendation");
      }
      if (has("color_palette")) {
        if (!isPlainObject(state.color_palette)) {
          errors.push(`"color_palette" must be an object with primary, secondary, background, and text`);
        } else {
          for (const k of ["primary", "secondary", "background", "text"]) {
            validateNonEmptyString(errors, state.color_palette, k, `color_palette.${k}`);
          }
          for (const [k, v] of Object.entries(state.color_palette)) {
            if (!isNonEmptyString(v)) {
              errors.push(`"color_palette.${k}" must be a non-empty string`);
            }
          }
        }
      }
      if (has("typography")) {
        if (!isPlainObject(state.typography)) {
          errors.push(`"typography" must be an object with headings and body`);
        } else {
          for (const k of ["headings", "body"]) {
            validateNonEmptyString(errors, state.typography, k, `typography.${k}`);
          }
          for (const [k, v] of Object.entries(state.typography)) {
            if (!isNonEmptyString(v)) {
              errors.push(`"typography.${k}" must be a non-empty string`);
            }
          }
        }
      }
      if (has("border_radius_base")) {
        validateNonEmptyString(errors, state, "border_radius_base");
      }
      break;
    }

    case "mockery": {
      if (has("fidelity") && !VALID_MOCKERY_FIDELITY.has(state.fidelity)) {
        errors.push(
          `Invalid mockery fidelity ${JSON.stringify(state.fidelity)} (expected "wireframe" or "styled")`
        );
      }
      if (has("mockups_dir")) {
        validateNonEmptyString(errors, state, "mockups_dir");
      }
      if (has("devices")) {
        validateStringArray(errors, state, "devices", {
          minLength: 1,
          allowedValues: VALID_MOCKERY_DEVICES,
        });
      }
      if (has("sections")) {
        validateStringArray(errors, state, "sections", { minLength: 0 });
      }
      if (has("screens")) {
        if (!Array.isArray(state.screens)) {
          errors.push(
            `"screens" must be an array of { id, title, file, device, ux_screen_ref, variant } objects`
          );
        } else {
          if (state.screens.length < 1) {
            errors.push(`"screens" must contain at least 1 screen object`);
          }
          state.screens.forEach((scr, idx) => {
            if (!isPlainObject(scr)) {
              errors.push(
                `"screens[${idx}]" must be an object with id, title, file, device, ux_screen_ref, and variant`
              );
              return;
            }
            validateNonEmptyString(errors, scr, "id", `screens[${idx}].id`);
            validateNonEmptyString(errors, scr, "title", `screens[${idx}].title`);
            validateNonEmptyString(errors, scr, "file", `screens[${idx}].file`);
            if (!isNonEmptyString(scr.device) || !VALID_MOCKERY_DEVICES.has(scr.device)) {
              errors.push(
                `"screens[${idx}].device" must be one of: ${[...VALID_MOCKERY_DEVICES].join(", ")}`
              );
            }
            validateNonEmptyString(errors, scr, "ux_screen_ref", `screens[${idx}].ux_screen_ref`);
            if (!VALID_MOCKERY_VARIANTS.has(scr.variant)) {
              errors.push(
                `"screens[${idx}].variant" must be one of: ${[...VALID_MOCKERY_VARIANTS].join(", ")}`
              );
            }
          });
        }
      }
      if (has("components")) {
        validateStringArray(errors, state, "components", { minLength: 0 });
      }
      if (has("edges_count")) {
        validateNonNegInteger(errors, state, "edges_count");
      }
      if (has("tokens_synced_from_ui")) {
        if (typeof state.tokens_synced_from_ui !== "boolean") {
          errors.push(`"tokens_synced_from_ui" must be a boolean`);
        } else if (VALID_MOCKERY_FIDELITY.has(state.fidelity)) {
          const expectedSynced = state.fidelity === "styled";
          if (state.tokens_synced_from_ui !== expectedSynced) {
            errors.push(
              `"tokens_synced_from_ui" must be ${expectedSynced} when fidelity is "${state.fidelity}"`
            );
          }
        }
      }
      break;
    }

    case "architecture": {
      if (has("frontend_stack")) {
        validateStringArray(errors, state, "frontend_stack", { minLength: 1 });
      }
      if (has("backend_stack")) {
        validateStringArray(errors, state, "backend_stack", { minLength: 1 });
      }
      if (has("database_type")) {
        validateNonEmptyString(errors, state, "database_type");
      }
      if (has("data_models")) {
        if (!Array.isArray(state.data_models)) {
          errors.push(`"data_models" must be an array of { entity, fields } objects`);
        } else {
          if (state.data_models.length < 1) {
            errors.push(`"data_models" must contain at least 1 data model object`);
          }
          state.data_models.forEach((dm, idx) => {
            if (!isPlainObject(dm)) {
              errors.push(`"data_models[${idx}]" must be an object with entity and fields`);
              return;
            }
            validateNonEmptyString(errors, dm, "entity", `data_models[${idx}].entity`);
            validateStringArray(errors, dm, "fields", {
              minLength: 1,
              label: `data_models[${idx}].fields`,
            });
          });
        }
      }
      if (has("core_endpoints")) {
        if (!Array.isArray(state.core_endpoints)) {
          errors.push(`"core_endpoints" must be an array of { method, path, purpose } objects`);
        } else {
          if (state.core_endpoints.length < 1) {
            errors.push(`"core_endpoints" must contain at least 1 endpoint object`);
          }
          state.core_endpoints.forEach((ep, idx) => {
            if (!isPlainObject(ep)) {
              errors.push(`"core_endpoints[${idx}]" must be an object with method, path, and purpose`);
              return;
            }
            validateNonEmptyString(errors, ep, "method", `core_endpoints[${idx}].method`);
            validateNonEmptyString(errors, ep, "path", `core_endpoints[${idx}].path`);
            validateNonEmptyString(errors, ep, "purpose", `core_endpoints[${idx}].purpose`);
          });
        }
      }
      break;
    }

    case "specs": {
      if (has("openapi_stubs")) {
        validateStringArray(errors, state, "openapi_stubs", { minLength: 1 });
      }
      if (has("required_unit_tests")) {
        validateStringArray(errors, state, "required_unit_tests", { minLength: 1 });
      }
      if (has("required_e2e_tests")) {
        validateStringArray(errors, state, "required_e2e_tests", { minLength: 1 });
      }
      if (has("linter_rules")) {
        validateStringArray(errors, state, "linter_rules", { minLength: 1 });
      }
      break;
    }

    case "review": {
      if (has("verdict") && !VALID_REVIEW_VERDICTS.has(state.verdict)) {
        errors.push(
          `Invalid review verdict ${JSON.stringify(state.verdict)} (expected "PASS" or "FAIL")`
        );
      }
      if (has("source_phases")) {
        validateStringArray(errors, state, "source_phases", {
          minLength: 1,
          allowedValues: VALID_STAGE_PHASES,
        });
      }
      if (has("target_phase")) {
        if (!isNonEmptyString(state.target_phase) || !VALID_STAGE_PHASES.has(state.target_phase)) {
          errors.push(
            `"target_phase" must be a valid pipeline phase (${[...VALID_STAGE_PHASES].join(", ")})`
          );
        }
      }
      const critOk = has("critical_violations_count")
        ? validateNonNegInteger(errors, state, "critical_violations_count")
        : false;
      if (has("scope_creep_warnings_count")) {
        validateNonNegInteger(errors, state, "scope_creep_warnings_count");
      }
      const blkOk = has("blocking_issues")
        ? validateStringArray(errors, state, "blocking_issues", { minLength: 0 })
        : false;

      if (VALID_REVIEW_VERDICTS.has(state.verdict) && critOk && blkOk) {
        if (
          state.verdict === "PASS" &&
          (state.critical_violations_count > 0 || state.blocking_issues.length > 0)
        ) {
          errors.push(
            `Review verdict "PASS" requires critical_violations_count === 0 and empty blocking_issues`
          );
        }
        if (
          state.verdict === "FAIL" &&
          state.critical_violations_count === 0 &&
          state.blocking_issues.length === 0
        ) {
          errors.push(
            `Review verdict "FAIL" requires critical_violations_count > 0 or at least one blocking_issues entry`
          );
        }
      }
      break;
    }

    default:
      break;
  }

  return { valid: errors.length === 0, errors };
}
