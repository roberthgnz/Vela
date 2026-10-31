// Vitest setup for the jsdom tests: Testing Library's DOM matchers (toBeDisabled, toHaveAttribute…).
import "@testing-library/jest-dom/vitest";

// The interface follows the system language (`src/lib/i18n.ts`); tests assert the Spanish texts.
if (typeof navigator !== "undefined") Object.defineProperty(navigator, "language", { value: "es-ES", configurable: true });
