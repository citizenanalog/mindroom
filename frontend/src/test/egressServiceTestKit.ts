import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import egressPresets from "@/test/fixtures/egressPresets.json";
import {
  type EditorOptions,
  type EgressServiceForm,
  emptyRule,
  formFromService,
  serializeService,
} from "@/connections/egressServiceForm";
import { validateService } from "@/connections/egressServiceValidation";
import type {
  AuthoredEgressService,
  EgressValidation,
  EgressPreset,
  EgressRule,
} from "@/connections/types";

/** What the editor model's tests share: the server's presets, the options of each context, and helpers that run a service through the form. */

export const presets = egressPresets.presets as EgressPreset[];
// What the server sends with the presets; typing it checks the fixture has the shape the editor reads.
export const validation: EgressValidation = egressPresets.validation;
export const personal: EditorOptions = {
  context: "personal",
  sharedTarget: false,
  presets,
  validation,
};
export const sharedPersonal: EditorOptions = {
  ...personal,
  sharedTarget: true,
};
export const operator: EditorOptions = { ...personal, context: "operator" };
export const newService = {
  editing: false,
  takenNames: [] as string[],
  service: null,
};

export const bearerRule: EgressRule = {
  host: "api.example.com",
  auth: { type: "bearer" },
};

export const serialize = (
  service: AuthoredEgressService,
  options: EditorOptions = personal,
  name = "svc",
) => serializeService(formFromService(name, service), options, service);

export const problemsFor = (
  service: AuthoredEgressService | null,
  changes: Partial<EgressServiceForm> = {},
  options: EditorOptions = personal,
  settings: { editing: boolean; takenNames: string[] } = newService,
) =>
  validateService({ ...formFromService("svc", service), ...changes }, options, {
    ...settings,
    service,
  });

export const errorsFor = (
  service: AuthoredEgressService | null,
  changes: Partial<EgressServiceForm> = {},
  options: EditorOptions = personal,
  settings: { editing: boolean; takenNames: string[] } = newService,
) =>
  problemsFor(service, changes, options, settings).map(
    (problem) => problem.message,
  );

export function basicAuth(username: string) {
  return { type: "basic", username } as const;
}

export function validRule() {
  return { ...emptyRule(), host: "api.example.com" };
}

/** Wait until an open editor has the server's presets in its dropdown. */
export const presetsReady = () =>
  waitFor(() => expect(screen.getByLabelText("Preset")).toBeEnabled());

/** Press a button of the open dialog, such as its confirm or Cancel button. */
export async function pressInDialog(name: string) {
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name }),
  );
}
