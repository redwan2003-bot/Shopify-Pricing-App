/**
 * Domain-specific pricing errors. Every failure the calculation engine can produce is
 * one of these — never a raw Prisma error, and never a silently-substituted default
 * price. Each carries a stable `code` so a future API layer can map it to an HTTP
 * status / client-facing message without string-matching `error.message`.
 */
export abstract class PricingError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class StoreNotFound extends PricingError {
  readonly code = "STORE_NOT_FOUND";
  constructor(shopDomain: string) {
    super(`No Store found for shopDomain "${shopDomain}"`);
  }
}

export class PricingProfileNotFound extends PricingError {
  readonly code = "PRICING_PROFILE_NOT_FOUND";
  constructor(shopDomain: string, sku: string) {
    super(`No PricingProfile found for store "${shopDomain}" and sku "${sku}"`);
  }
}

export class PricingProfileInactive extends PricingError {
  readonly code = "PRICING_PROFILE_INACTIVE";
  constructor(shopDomain: string, sku: string) {
    super(`PricingProfile for store "${shopDomain}" and sku "${sku}" is not active`);
  }
}

export class InvalidQuantity extends PricingError {
  readonly code = "INVALID_QUANTITY";
  constructor(quantity: unknown) {
    super(`quantity must be a positive integer, got ${JSON.stringify(quantity)}`);
  }
}

export class QuantityTierNotFound extends PricingError {
  readonly code = "QUANTITY_TIER_NOT_FOUND";
  constructor(pricingProfileId: string) {
    super(`PricingProfile "${pricingProfileId}" has no quantity tiers configured`);
  }
}

export class QuantityBelowMinimum extends PricingError {
  readonly code = "QUANTITY_BELOW_MINIMUM";
  constructor(requested: number, minimum: number) {
    super(`quantity ${requested} is below the minimum supported quantity ${minimum}`);
  }
}

export class InvalidDecorationSelection extends PricingError {
  readonly code = "INVALID_DECORATION_SELECTION";
}

export class DecorationRuleNotFound extends PricingError {
  readonly code = "DECORATION_RULE_NOT_FOUND";
  constructor(method: string, code: string) {
    super(`No DecorationRule with code "${code}" configured for method "${method}"`);
  }
}

export class InvalidOptionGroup extends PricingError {
  readonly code = "INVALID_OPTION_GROUP";
  constructor(groupName: string) {
    super(`No OptionGroup named "${groupName}" on this pricing profile`);
  }
}

export class InvalidOptionValue extends PricingError {
  readonly code = "INVALID_OPTION_VALUE";
  constructor(optionValueId: string) {
    super(`No OptionValue with id "${optionValueId}" on this pricing profile`);
  }
}

export class OptionValueGroupMismatch extends PricingError {
  readonly code = "OPTION_VALUE_GROUP_MISMATCH";
  constructor(optionValueId: string, requestedGroup: string, actualGroup: string) {
    super(
      `OptionValue "${optionValueId}" belongs to group "${actualGroup}", not the requested group "${requestedGroup}"`,
    );
  }
}

export class DuplicateOptionSelection extends PricingError {
  readonly code = "DUPLICATE_OPTION_SELECTION";
  constructor(groupName: string) {
    super(`More than one option was selected for group "${groupName}"`);
  }
}

export class MissingRequiredOptionGroup extends PricingError {
  readonly code = "MISSING_REQUIRED_OPTION_GROUP";
  constructor(groupName: string) {
    super(`Group "${groupName}" is required and no option was selected for it`);
  }
}

export class OptionPricingUnavailable extends PricingError {
  readonly code = "OPTION_PRICING_UNAVAILABLE";
  constructor(groupName: string, label: string) {
    super(
      `Neither option "${label}" (group "${groupName}") nor its group has a price configured — refusing to charge $0`,
    );
  }
}

export class ProductColorNotFound extends PricingError {
  readonly code = "PRODUCT_COLOR_NOT_FOUND";
  constructor(code: string) {
    super(`No active ProductColor with code "${code}" on this pricing profile`);
  }
}

/** Thrown when a requested decoration color count (e.g. "4 colors") has no configured
 * DecorationColorCharge for some color number in range — e.g. color 2 and 3 are priced
 * but color 4 isn't. Never silently skipped or treated as $0 — see
 * calculator.ts's per-color loop and docs/pricing-model-expansion.md. */
export class ColorPricingUnavailable extends PricingError {
  readonly code = "COLOR_PRICING_UNAVAILABLE";
  constructor(method: string, colorNumber: number) {
    super(
      `No DecorationColorCharge configured for method "${method}" color ${colorNumber} — refusing to charge $0`,
    );
  }
}

export class ProductionRuleNotFound extends PricingError {
  readonly code = "PRODUCTION_RULE_NOT_FOUND";
  constructor(code: string, reason?: string) {
    super(`No usable ProductionRule for code "${code}"${reason ? ` — ${reason}` : ""}`);
  }
}

export class PricingConfigurationInvalid extends PricingError {
  readonly code = "PRICING_CONFIGURATION_INVALID";
}
