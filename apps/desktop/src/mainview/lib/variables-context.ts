/**
 * Flow-scoped typed variable declarations.
 *
 * Variables are declared per-flow in the flow JSON `variables` array.
 * Set Variable and Get Variable nodes consume this context to show
 * dropdowns of declared names and to color pins by declared type.
 *
 * Inspired by UE Blueprint's variable system: declare centrally,
 * use via typed Get/Set nodes.
 */

import { createContext, useContext } from "react";
import type { DataType } from "@twistedflow/core";

/** A single variable declaration in the flow's `variables` array. */
export interface FlowVariable {
  /** Variable name — must be unique within the flow. */
  name: string;
  /** Data type — determines pin color and schema resolution. */
  type: DataType;
  /** Default value (as a string). Pre-seeded at execution start. */
  default?: string;
}

export interface FlowVariablesContextValue {
  /** The flow's declared variables. */
  variables: FlowVariable[];
  /** Update the flow's variable declarations (triggers autosave). */
  setVariables: (vars: FlowVariable[]) => void;
}

export const FlowVariablesContext = createContext<FlowVariablesContextValue>({
  variables: [],
  setVariables: () => {},
});

/** Hook for node components to access flow variable declarations. */
export function useFlowVariables(): FlowVariablesContextValue {
  return useContext(FlowVariablesContext);
}
